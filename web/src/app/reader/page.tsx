'use client'

import { useState } from 'react'
import Header from '@/components/Header'
import Hero from '@/components/Hero'
import Features from '@/components/Features'
import HowItWorks from '@/components/HowItWorks'
import Pricing from '@/components/Pricing'
import VoiceCloning from '@/components/VoiceCloning'
import DeveloperPromo from '@/components/DeveloperPromo'
import FAQ from '@/components/FAQ'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen bg-dark">
      <Header />
      <Hero />
      <Features />
      <HowItWorks />
      <VoiceCloning />
      <Pricing />
      <DeveloperPromo />
      <FAQ />
      <Footer />
    </main>
  )
}
