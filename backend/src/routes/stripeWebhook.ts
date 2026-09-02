import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabaseClient.js';
import { activateBillingFromCheckout, deactivateBillingForSubscription } from '../lib/realtimeTtsBilling.js';

// realtime-tts checkouts/subscriptions are tagged with this metadata so they
// can be routed away from ReadAloud's own "pro" subscription handlers below
// — both fire the same Stripe event types, but a realtime-tts subscription
// happens to use a different (freshly-created) Stripe Customer than a user's
// main ReadAloud subscription, so the existing handlers would silently no-op
// on it rather than corrupt anything. Branching explicitly is safer than
// relying on that non-collision by accident.
function isRealtimeTtsEvent(metadata: Stripe.Metadata | null | undefined): boolean {
  return metadata?.product === 'realtime-tts-api';
}

const router = Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Stripe webhook handler
// Note: This route needs raw body, not JSON parsed
router.post('/stripe', async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['stripe-signature'] as string;

  if (!signature) {
    logger.warn('Missing stripe-signature header');
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  let event: Stripe.Event;

  try {
    // req.body should be raw buffer for Stripe signature verification
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  logger.info({ type: event.type, id: event.id }, 'Stripe webhook received');

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (isRealtimeTtsEvent(session.metadata)) {
          await activateBillingFromCheckout(session);
        } else {
          await handleCheckoutCompleted(session);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        if (!isRealtimeTtsEvent(subscription.metadata)) {
          await handleSubscriptionUpdate(subscription);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        if (isRealtimeTtsEvent(subscription.metadata)) {
          await deactivateBillingForSubscription(subscription.id);
        } else {
          await handleSubscriptionCancelled(subscription);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        logger.info({ invoiceId: invoice.id }, 'Payment succeeded');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(invoice);
        break;
      }

      default:
        logger.info({ type: event.type }, 'Unhandled webhook event type');
    }

    res.json({ received: true });
  } catch (error) {
    logger.error({ error, eventType: event.type }, 'Webhook handler error');
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Handle checkout session completed
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const customerEmail = session.customer_email || session.customer_details?.email;

  logger.info({
    sessionId: session.id,
    customerId,
    subscriptionId,
    email: customerEmail,
  }, 'Checkout completed');

  if (!customerEmail) {
    logger.warn({ sessionId: session.id }, 'No customer email in checkout session');
    return;
  }

  // Find user by email and update their subscription info
  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id')
    .eq('email', customerEmail)
    .single();

  if (findError || !user) {
    logger.warn({ email: customerEmail, error: findError }, 'User not found for checkout');
    return;
  }

  // Update user with Stripe customer and subscription IDs
  const { error: updateError } = await supabase
    .from('users')
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      subscription_tier: 'pro',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (updateError) {
    logger.error({ userId: user.id, error: updateError }, 'Failed to update user subscription');
  } else {
    logger.info({ userId: user.id }, 'User subscription activated');
  }
}

// Handle subscription updates
async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;
  const status = subscription.status;

  logger.info({
    subscriptionId: subscription.id,
    customerId,
    status,
  }, 'Subscription updated');

  // Find user by Stripe customer ID
  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (findError || !user) {
    logger.warn({ customerId, error: findError }, 'User not found for subscription update');
    return;
  }

  // Determine tier based on subscription status
  const tier = ['active', 'trialing'].includes(status) ? 'pro' : 'free';

  const { error: updateError } = await supabase
    .from('users')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_tier: tier,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (updateError) {
    logger.error({ userId: user.id, error: updateError }, 'Failed to update subscription status');
  }
}

// Handle subscription cancellation
async function handleSubscriptionCancelled(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  logger.info({
    subscriptionId: subscription.id,
    customerId,
  }, 'Subscription cancelled');

  // Find user by Stripe customer ID
  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (findError || !user) {
    logger.warn({ customerId, error: findError }, 'User not found for subscription cancellation');
    return;
  }

  // Downgrade to free tier
  const { error: updateError } = await supabase
    .from('users')
    .update({
      subscription_tier: 'free',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  if (updateError) {
    logger.error({ userId: user.id, error: updateError }, 'Failed to downgrade subscription');
  } else {
    logger.info({ userId: user.id }, 'User downgraded to free tier');
  }
}

// Handle failed payments
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  logger.warn({
    invoiceId: invoice.id,
    customerId,
    attemptCount: invoice.attempt_count,
  }, 'Payment failed');

  // Find user by Stripe customer ID
  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id, email')
    .eq('stripe_customer_id', customerId)
    .single();

  if (findError || !user) {
    logger.warn({ customerId, error: findError }, 'User not found for payment failure');
    return;
  }

  // TODO: Send payment failure notification email
  logger.info({ userId: user.id, email: user.email }, 'Should notify user about payment failure');
}

export { router as stripeWebhookRouter };
