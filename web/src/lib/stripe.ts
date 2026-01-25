import Stripe from 'stripe'

// Server-side Stripe instance
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

// Price IDs - configure these in your Stripe Dashboard
export const STRIPE_PRICES = {
  pro_weekly: process.env.STRIPE_PRICE_PRO_WEEKLY!,
  pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY!,
}

export const STRIPE_PRODUCTS = {
  pro: process.env.STRIPE_PRODUCT_PRO!,
}
