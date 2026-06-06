import type { Transition, Variants } from 'framer-motion'

// One place to tune the panel's motion feel. Values mirror the reference app:
// smooth slide-up reveals with a gentle top-to-bottom stagger.

/** Smooth, natural easing for content reveals. */
export const EASE = [0.25, 0.46, 0.45, 0.94] as const
/** Snappy material-style easing for UI/exits. */
export const EASE_OUT = [0.4, 0, 0.2, 1] as const

/** Page wrapper: slides up + fades in on navigate, cascades its children. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: EASE, when: 'beforeChildren', staggerChildren: 0.05, delayChildren: 0.02 },
  },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease: EASE_OUT } },
}

/** A staggered child — slides up + fades in. */
export const itemVariants: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
}

/** A list/grid container that cascades its `itemVariants` children top-to-bottom. */
export const listContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
}

/** Spring for the sliding active-nav highlight (layoutId). */
export const navSpring: Transition = { type: 'spring', stiffness: 350, damping: 30 }
