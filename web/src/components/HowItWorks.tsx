'use client'

import { motion } from 'framer-motion'
import { FileUp, Mic, Play, Headphones } from 'lucide-react'

const steps = [
  {
    number: '01',
    icon: FileUp,
    title: 'Import Your Content',
    description: 'Share an article from your browser, import a PDF, or paste text directly into the app.',
  },
  {
    number: '02',
    icon: Mic,
    title: 'Choose Your Voice',
    description: 'Select from 50+ natural AI voices or use your own cloned voice for a personalized experience.',
  },
  {
    number: '03',
    icon: Play,
    title: 'Press Play',
    description: 'Start listening instantly. Adjust speed and pick up right where you left off.',
  },
  {
    number: '04',
    icon: Headphones,
    title: 'Listen Anywhere',
    description: 'Enjoy your content during commutes, workouts, or while doing chores. Background playback included.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 bg-dark">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Simple as{' '}
            <span className="gradient-text">1-2-3-4</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            Start listening to your content in seconds
          </p>
        </motion.div>

        <div className="relative">
          {/* Connection line */}
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-primary/20 via-primary to-primary/20 -translate-y-1/2" />

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {steps.map((step, index) => (
              <motion.div
                key={step.number}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: index * 0.15 }}
                className="relative"
              >
                {/* Step card */}
                <div className="bg-dark-secondary rounded-2xl p-6 relative z-10 border border-dark-tertiary hover:border-primary/30 transition-colors">
                  {/* Step number */}
                  <div className="absolute -top-4 left-6 bg-primary text-dark text-sm font-bold px-3 py-1 rounded-full">
                    {step.number}
                  </div>

                  {/* Icon */}
                  <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4 mt-2">
                    <step.icon className="w-8 h-8 text-primary" />
                  </div>

                  <h3 className="text-xl font-semibold text-white mb-2">{step.title}</h3>
                  <p className="text-gray-400">{step.description}</p>
                </div>

                {/* Connector dot for desktop */}
                {index < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-1/2 -right-4 w-3 h-3 bg-primary rounded-full -translate-y-1/2 z-20" />
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
