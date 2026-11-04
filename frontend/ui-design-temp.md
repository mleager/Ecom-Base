# Frontend Design and UI

## Environment and Tools:
- Vite, React, Typescript
- TailwindCSS, Shadcn


## Desired Styling

### Global Styling

1. Accounts should be a softer green or blue instead of the current neon yellowish (search button in header/banner, Add to cart button, etc.)

- The current blue coloring for Product names and links, and green for In stock can stay - unless a better palette fits the design better


### Catalog / Main Page

1. Product Cards should be clickable, not just the link in it

2. When hovering over a Product Card, it should either slightly increase in size, or display the truncated description using the Shadcn "Hover Card" component

- to accent that the user will be clicking that card

3. When one or more items are in the cart and the user is still browsing, show the cart contents using the Shadcn "Sidebar" component

- this is a reference to how Amazon show's the cart's contents on the right side of the screen


### Account Page for Signed In User

1. "Account security" and "Shipping address" links should be buttons


### Shipping Address Page

1. Remove "Reload Addresses" button


### Add Shipping Address Page

1. "Address Label" field should be a Shadcn "Select" component with "Home", "Business", "Other" options

- requires updating the backend so it uses an Enum or similar data structure


### Cart Page

1. Remove "Set quantity" and "Add quantity" buttons, instead use the Shadcn "Select" component to select a quantity

- The quantity should already be 1 after user clicks "Add to cart" from Product Page and is directed to the Cart Page


### Review Checkout Page

1. Shows previous order status and requires you to click "Review a new checkout"

- It should only show what was added from the current cart, not a previous order status

- The previous order status should be available at "Your orders" link in the header


2. "Add a shipping address" and "Manage shipping address" should be buttons, not links

3. "Your orders" and "Review cart" links at the bottom of the page can be removed 

4. After completing the order, the "Check Status" button just shows text that says "Automatic observation stopped while the saved order reference was being verified. Check Status performs one bounded read."

- this should return the order status (pending, confirmed, rejected, etc.)


### Admin Main Page

1. Remove "Your account" and "Return home" links, as they are already in the header


### Admin View Products

1. Filter should include a search bar

2. Should use Shadcn "Pagination" component instead of just using "Next" button


### Admin Create Product

1. Product quantity is modified by selecting "View inventory" link at the bottom of the page

- It should be named "Adjust inventory quantity" and be a button

2. After creating a product, the links at the bottom of the page should be buttons instead


