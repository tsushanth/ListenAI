import { NextRequest, NextResponse } from 'next/server'
import { stripe, STRIPE_PRICES } from '@/lib/stripe'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const plan = searchParams.get('plan')

  if (!plan || !['pro_weekly', 'pro_yearly'].includes(plan)) {
    return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  }

  try {
    const priceId = STRIPE_PRICES[plan as keyof typeof STRIPE_PRICES]

    if (!priceId) {
      return NextResponse.json({ error: 'Price not configured' }, { status: 500 })
    }

    const isSubscription = true // All plans are subscriptions now

    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/#pricing`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      ...(isSubscription && {
        subscription_data: {
          trial_period_days: 7,
        },
      }),
    })

    // Redirect to Stripe Checkout
    return NextResponse.redirect(session.url!, { status: 303 })
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}
