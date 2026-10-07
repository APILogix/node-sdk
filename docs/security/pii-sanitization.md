# PII Sanitization & Compliance Rules

## 1. Compliance Architecture (GDPR, PCI-DSS, HIPAA)

`@pulse-apm/node` is engineered to comply with enterprise security and data privacy mandates (GDPR, PCI-DSS, HIPAA). Observability data captured by the SDK is scrubbed locally on the client host before network transmission or disk persistence.

---

## 2. Scrubbing Rules & Defaults

### 2.1 Default Redacted Headers
The following HTTP headers are stripped unconditionally from all request, error, and span records:
- `Authorization`
- `Proxy-Authorization`
- `Cookie`
- `Set-Cookie`
- `X-Api-Key`, `X-Auth-Token`

### 2.2 Credit Card Masking (PCI-DSS)
When `maskCreditCards: true` (the default), strings across all payload attributes are evaluated against credit card pattern matchers:
- Detects Visa, MasterCard, American Express, and Discover formats.
- Validates candidate numbers using the Luhn algorithm to prevent false positives.
- Masks matching values to `[CREDENTIAL_MASKED]`.

### 2.3 Custom Field Redaction
Developers can append proprietary sensitive fields via `init()` options:

```typescript
await init({
  apiKey: '...',
  scrubFields: [
    'ssn',
    'bank_account',
    'medical_record_number',
    'tax_id',
    'date_of_birth',
  ],
});
```

Any object property or URL query parameter matching these keys (case-insensitively) will have its value replaced with `"[REDACTED]"`.
