'use client'

import { motion } from 'framer-motion'
import { FileText, Mic2, Globe, Zap, Share2, BookOpen, Gauge, Headphones } from 'lucide-react'

const features = [
  {
    icon: FileText,
    title: 'Import Anything',
    description: 'Import articles, PDFs, emails, or paste text directly. We extract and clean the content automatically.',
  },
  {
    icon: Mic2,
    title: 'Voice Cloning',
    description: 'Clone your own voice or anyone\'s voice with just 30 seconds of audio. Listen in a voice you love.',
  },
  {
    icon: Globe,
    title: '50+ Natural Voices',
    description: 'Choose from over 50 AI voices in 10+ languages. Find the perfect narrator for your content.',
  },
  {
    icon: Zap,
    title: 'Instant Playback',
    description: 'Start listening within seconds. Our streaming technology begins playback while still processing.',
  },
  {
    icon: Gauge,
    title: 'Speed Control',
    description: 'Adjust playback speed from 0.5x to 3x. Listen faster or slower based on your preference.',
  },
  {
    icon: Share2,
    title: 'Share Extension',
    description: 'Share directly from Safari, Chrome, or any app. One tap to add content to your library.',
  },
  {
    icon: BookOpen,
    title: 'Smart Library',
    description: 'Organize your content with tags and folders. Search across all your saved articles.',
  },
  {
    icon: Headphones,
    title: 'Background Playback',
    description: 'Keep listening while you multitask. Control playback from your lock screen.',
  },
]

export default function Features() {
  return (
    <section id="features" className="py-24 bg-dark-secondary">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Everything You Need to{' '}
            <span className="gradient-text">Listen Smarter</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            Powerful features designed to transform how you consume content
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.1 }}
              className="bg-dark-tertiary rounded-2xl p-6 hover:bg-dark-tertiary/80 transition-colors group"
            >
              <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center mb-4 group-hover:bg-primary/30 transition-colors">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">{feature.title}</h3>
              <p className="text-gray-400 text-sm">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
