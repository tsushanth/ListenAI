'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    question: 'How does ReadAloud AI work?',
    answer: 'ReadAloud AI uses advanced text-to-speech technology to convert written content into natural-sounding audio. Simply import an article from a URL, upload a PDF, or paste text directly. Choose your preferred AI voice, and start listening instantly.',
  },
  {
    question: 'What types of content can I import?',
    answer: 'You can import content from URLs (articles, blog posts), PDFs, plain text, and even emails. Our intelligent content extraction removes ads and clutter to give you clean, readable audio.',
  },
  {
    question: 'How does voice cloning work?',
    answer: 'Voice cloning requires just 30 seconds of your voice reading a provided text sample. Our AI analyzes your unique voice characteristics and creates a personalized voice that can read any text. This is a PRO feature.',
  },
  {
    question: 'Is my voice data secure?',
    answer: 'Absolutely. Your voice recordings and cloned voice data are encrypted and stored securely. We never share your voice data with third parties, and you can delete your cloned voices at any time.',
  },
  {
    question: 'Can I use ReadAloud offline?',
    answer: 'Currently, ReadAloud requires an internet connection to process and synthesize audio. However, you can download articles for offline listening in the PRO plan.',
  },
  {
    question: 'What languages are supported?',
    answer: 'ReadAloud supports 10+ languages including English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, and more. Each language has multiple natural-sounding voices to choose from.',
  },
  {
    question: 'How do I cancel my subscription?',
    answer: 'You can cancel your subscription anytime through your app store (App Store or Google Play) subscription settings. Your PRO features will remain active until the end of your billing period.',
  },
  {
    question: 'Is there a free trial?',
    answer: 'Yes! PRO subscriptions include a 7-day free trial. You can try all premium features without being charged. Cancel anytime during the trial period.',
  },
]

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section id="faq" className="py-24 bg-dark-secondary">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Frequently Asked{' '}
            <span className="gradient-text">Questions</span>
          </h2>
          <p className="text-xl text-gray-400">
            Everything you need to know about ReadAloud AI
          </p>
        </motion.div>

        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="bg-dark-tertiary rounded-2xl overflow-hidden"
            >
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="w-full px-6 py-5 flex items-center justify-between text-left"
              >
                <span className="text-white font-medium pr-4">{faq.question}</span>
                <ChevronDown
                  className={`w-5 h-5 text-gray-400 transition-transform flex-shrink-0 ${
                    openIndex === index ? 'rotate-180' : ''
                  }`}
                />
              </button>

              <AnimatePresence>
                {openIndex === index && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div className="px-6 pb-5">
                      <p className="text-gray-400">{faq.answer}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
