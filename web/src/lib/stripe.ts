import Stripe from 'stripe'

// Server-side Stripe instance
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
})

// Price IDs - configure these in your Stripe Dashboard
export const STRIPE_PRICES = {
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY!,
  pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY!,
  lifetime: process.env.STRIPE_PRICE_LIFETIME!,
}

export const STRIPE_PRODUCTS = {
  pro: process.env.STRIPE_PRODUCT_PRO!,
  lifetime: process.env.STRIPE_PRODUCT_LIFETIME!,
}
