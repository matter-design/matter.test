# Northwind Outdoor: Checkout v2 brief

Prepared for Matter Design. Version 1.2.

## 1. Background

Northwind Outdoor sells camping and hiking gear in Australia and New Zealand through a BigCommerce store. The current checkout has four pages and loses about a third of shoppers between the cart and payment. Checkout v2 replaces it with a one-page checkout.

## 2. Scope

### 2.1 In scope

- One-page checkout for guests and signed-in customers
- Shipping options, including click-and-collect from our stores
- Promo codes and gift cards
- The payment step, up to the hand-off to the payment gateway

### 2.2 Out of scope

- The payment gateway itself (tested by the vendor)
- Load testing
- Order sync to the ERP

## 3. Checkout

### 3.1 Guest checkout

Shoppers must be able to check out without an account. The contact step asks only for an email address and a mobile number. After the order is placed, the confirmation page offers to create an account with one click, using the details already entered.

### 3.2 Signed-in customers

Signed-in customers see their saved addresses and can pick one with a single tap. The default address is selected when the checkout loads.

## 4. Shipping

Standard shipping is free on orders over $99 (AUD). Below that it costs $9.95. Express shipping costs $14.95 and is not available to PO boxes.

### 4.1 Click-and-collect

Shoppers can choose to collect from one of our 12 stores. The store picker shows stock for every item in the cart. If an item is out of stock at the chosen store, show "Not available here" next to it and suggest the nearest store that has everything in stock.

## 5. Promo codes and gift cards

### 5.1 Applying a code

The promo code field sits under the order summary, collapsed behind "Add a promo code". A valid code shows a discount line in the summary straight away.

### 5.2 Invalid and expired codes

If a code has expired, show "This code expired on {date}" under the field and keep the cart total unchanged. If a code doesn't exist, show "We don't recognise that code". The error must be announced to screen reader users.

### 5.3 Stacking

Only one promo code can be used per order unless both codes are marked stackable in BigCommerce. Gift cards can be combined with a promo code.

## 6. Payment

Cards (Visa, Mastercard, Amex), PayPal and Afterpay are offered. Afterpay is only shown for orders between $35 and $2,000. If a card is declined, keep the shopper on the payment step with their details intact and show the gateway's message.

## 7. Accessibility and speed

The checkout must meet WCAG 2.2 AA. It should load fast on mobile.
