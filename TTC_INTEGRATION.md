# Tương Tác Chéo (TTC) Integration

## Verified API contract

The TTC order API contract is now implemented from the provider documentation supplied for Work 06.

- API base URL: `https://tuongtaccheo.com/api/v2`
- HTTP method: `POST`
- Content-Type: `application/x-www-form-urlencoded`
- Response: JSON
- Authentication field: `key=<API Key>`

The separate TTC `Access_token`/`logintoken.php` flow shown in the documentation is for tool login and is not used by the provider order adapter.

## Implemented actions

### Services

Form fields:

```text
key=<API key>
action=services
```

The adapter consumes `service`, `name`, `type`, `category`, `rate`, `min`, `max`, and `refill`.

Work 06 can safely submit the documented `Default` and `Package` order types because both use service/link/quantity. `Custom Comments/Texts` requires an additional `comments` payload that the current customer Order model does not contain, so those provider services are synced as unavailable until a dedicated customer input model is implemented.

### Add order

```text
key=<API key>
action=add
service=<Service ID>
link=<Link>
quantity=<Needed quantity>
```

A successful response must contain:

```json
{ "order": 99999 }
```

The TTC documentation does not expose a client idempotency/reference field for `add`, so `supportsCreateIdempotency=false`. A timeout after request transmission remains an ambiguous submission and is routed to manual review rather than blindly retried.

### Order status

```text
key=<API key>
action=status
order=<Order ID>
```

Documented status values normalize as:

- `Pending` -> `PENDING`
- `Processing` -> `PROCESSING`
- `In progress` -> `PROCESSING`
- `Completed` -> `COMPLETED`
- `Partial` -> `PARTIAL`
- `Canceled` -> `CANCELLED`

The adapter also tolerates `Cancelled`, `Failed`, and `Refunded` defensively without treating unknown strings as terminal.

### Cancel order

```text
key=<API key>
action=cancel
order=<Order ID>
```

The adapter exposes the documented cancel operation. It returns an accepted cancel request as `PENDING`; normal status polling remains authoritative for the terminal order state.

### Balance

```text
key=<API key>
action=balance
```

The documented response contains `balance` and `currency`. The supplied documentation example reports currency `XU`.

## TTC XU -> VND pricing guard

The application sells customer services in VND, while the TTC documentation reports provider balance/rates in XU. Work 06 does not assume an exchange value.

Work 07.1 centralizes provider environment parsing. `TTC_XU_TO_VND_RATE` is intentionally blank in `.env.example`; routing fails closed until an authoritative positive decimal conversion, API key and rate-input unit are configured. Numeric values reject signs, whitespace, decimals where integers are required and exponent notation. Provider routing can remain disabled without TTC credentials for local development, builds and unit tests.

Worker timing is validated before use. The job lock timeout must exceed the TTC HTTP timeout so a job cannot become stale while its provider request is still within the configured request window. Poll intervals, batch size and retry attempts must also be positive and internally consistent.

Before syncing TTC services into authoritative provider economics, configure:

```env
TTC_XU_TO_VND_RATE=<VND value of 1 TTC XU>
TTC_RATE_UNIT=1000
```

`TTC_XU_TO_VND_RATE` is applied using integer-safe decimal arithmetic and rounded upward to the nearest VND for margin protection.

## Environment

```env
TTC_API_BASE_URL="https://tuongtaccheo.com/api/v2"
TTC_API_KEY=<server-side TTC API key>
TTC_HTTP_TIMEOUT_MS=10000
TTC_XU_TO_VND_RATE=<authoritative conversion>
TTC_RATE_UNIT=1000
```

Never use `NEXT_PUBLIC_` for TTC credentials.

## Safe test order

Read-only test:

```text
npm run qa:ttc:readonly
```

A real provider order is deliberately gated. Configure a known low-cost TTC service and explicit opt-in:

```env
TTC_LIVE_TEST_ALLOW_ORDER="YES_I_UNDERSTAND"
TTC_LIVE_TEST_SERVICE_ID=<provider service ID>
TTC_LIVE_TEST_LINK=<safe test target>
TTC_LIVE_TEST_QUANTITY=<small valid quantity>
```

Then run:

```text
npm run qa:ttc:order
```

This can spend TTC provider balance. It must not be used with production customer data unintentionally.


## TTC raw-rate normalization

The adapter normalizes provider XU cost to VND per internal rate unit before `ProviderService` persistence. The repository does not contain an authoritative XU-to-VND conversion. Configure `TTC_XU_TO_VND_RATE` only from verified account/provider evidence during Work 07.2, together with the provider's rate-input unit. Keep routing disabled until that evidence is recorded and the resulting margins are reviewed.

Custom Comments services are synced but remain unavailable for automatic ordering until the customer Order input model carries the required comments/text payload.
