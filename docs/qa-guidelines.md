<!--
Matter Design QA guidelines for the MatterTest agent.

Claude reads this file every time it extracts requirements from a source and every time it drafts a test plan,
for every project. Write it as you would brief a new QA analyst. Edits take effect on the next run (no restart).

Precedence: the sources decide what the site must do. This guide sets the house style and standing rules.
A project's "Instructions for the agent" (Test assets) and a source's note override this guide for that project.

Everything below is a starting point: change, add or delete freely. Lines inside these comment markers are not sent.
-->

# Matter Design QA guidelines

## Priorities

- **P0:** a failure stops a customer buying, booking or contacting the client, takes or shows the wrong money, loses data, or breaks the law (privacy, consumer law, accessibility obligations).
- **P1:** a failure breaks a feature a customer or the client's staff rely on, but there's a workaround.
- **P2:** cosmetic, content or convenience problems.
- Payments, checkout, booking, sign-in and forms that send leads are at least P1, and P0 when money or a booking is involved.

## Writing test cases

- One behaviour per test case. Title it as the outcome a tester checks, e.g. "Expired promo code shows its expiry date".
- Steps are single actions in the browser, written as instructions ("Enter …", "Select …", "Press …").
- Expected results are what the tester can see: exact messages, totals and states when the source gives them.
- Preconditions say what must be set up first (account, cart contents, settings in the CMS).
- Don't repeat the same check across cases; reference the other case instead.

## Test data

- Say when a value is invented.
- Use Australian addresses, phone numbers (+61) and prices in AUD with GST unless the project says otherwise.
- Payments: use the gateway's published test cards in its test mode, never real cards.
- Name test accounts and orders so they're easy to find and clean up (e.g. prefix with "QA-").

## Always consider (when the sources touch the area)

- **Accessibility:** WCAG 2.2 AA: keyboard use, visible focus, labels, error messages announced to screen readers, colour contrast.
- **Mobile:** the same journey on a phone-sized screen.
- **Forms:** required fields, validation messages, what happens on success, where submissions go (email, CRM).
- **Analytics and consent:** key events fire (e.g. GA4 purchase, lead), and the cookie banner is honoured.
- **SEO basics** on new or changed pages: title, meta description, one H1, no accidental noindex.

Raise a question rather than inventing a requirement when one of these matters but the sources don't say what's expected.

## Leave out unless a source asks for it

- Third-party systems' own internals (payment gateways, ERPs, CRMs): test up to the hand-off.
- Load and performance testing beyond a page feeling fast.
- Browser versions older than the current and previous major release.

## Platform notes

- **BigCommerce / Shopify:** distinguish theme behaviour from platform behaviour; settings changed in the admin are preconditions.
- **WordPress:** note which plugin provides a feature when the source says.

## Wording

- Plain Australian English. Use the client's names for things (products, pages, features).
