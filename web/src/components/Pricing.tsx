'use client'

import { motion } from 'framer-motion'
import { Check, Sparkles } from 'lucide-react'
import Link from 'next/link'

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'Perfect for trying out ReadAloud',
    features: [
      '5 articles per month',
      '10 AI voices',
      'Standard quality audio',
      'Basic speed control',
      'Import from URL',
    ],
    cta: 'Get Started',
    href: '#download',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$4.99',
    period: 'per month',
    yearlyPrice: '$39.99/year',
    description: 'For daily listeners who want more',
    features: [
      'Unlimited articles',
      '50+ AI voices',
      'Premium HD audio quality',
      'Voice cloning (up to 10)',
      'Import PDFs & documents',
      'Speed control up to 3x',
      'Priority processing',
      'No ads',
    ],
    cta: 'Start Free Trial',
    href: '/api/checkout?plan=pro_monthly',
    highlighted: true,
  },
  {
    name: 'Lifetime',
    price: '$99',
    period: 'one-time',
    description: 'Pay once, own forever',
    features: [
      'Everything in Pro',
      'Unlimited voice clones',
      'Lifetime updates',
      'Priority support',
      'Early access to new features',
    ],
    cta: 'Get Lifetime Access',
    href: '/api/checkout?plan=lifetime',
    highlighted: false,
  },
]

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 bg-dark">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Simple, Transparent{' '}
            <span className="gradient-text">Pricing</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            Choose the plan that fits your listening needs
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.1 }}
              className={`relative rounded-3xl p-8 ${
                plan.highlighted
                  ? 'bg-gradient-to-b from-primary/20 to-dark-secondary border-2 border-primary'
                  : 'bg-dark-secondary border border-dark-tertiary'
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-dark text-sm font-bold px-4 py-1 rounded-full flex items-center space-x-1">
                  <Sparkles className="w-4 h-4" />
                  <span>Most Popular</span>
                </div>
              )}

              <div className="text-center mb-6">
                <h3 className="text-xl font-semibold text-white mb-2">{plan.name}</h3>
                <div className="flex items-baseline justify-center space-x-1">
                  <span className="text-4xl font-bold text-white">{plan.price}</span>
                  <span className="text-gray-400">/{plan.period}</span>
                </div>
                {plan.yearlyPrice && (
                  <p className="text-sm text-primary mt-1">or {plan.yearlyPrice} (save 33%)</p>
                )}
                <p className="text-gray-400 text-sm mt-2">{plan.description}</p>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center space-x-3">
                    <Check className="w-5 h-5 text-primary flex-shrink-0" />
                    <span className="text-gray-300 text-sm">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`block w-full py-3 px-4 rounded-xl font-semibold text-center transition-colors ${
                  plan.highlighted
                    ? 'bg-primary text-dark hover:bg-primary-dark'
                    : 'bg-dark-tertiary text-white hover:bg-dark-tertiary/80'
                }`}
              >
                {plan.cta}
              </Link>
            </motion.div>
          ))}
        </div>

        {/* Money back guarantee */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="text-center mt-12"
        >
          <p className="text-gray-400">
            7-day free trial for Pro. Cancel anytime. 30-day money-back guarantee.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
