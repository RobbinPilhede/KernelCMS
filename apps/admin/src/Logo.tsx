// KernelCMS lockup: the Norrsken radiant star (used with permission — the user's
// own design) as the mark, in an animated monochrome gradient (a sheen that
// sweeps between two theme-driven blacks/greys), paired with a thin geometric
// Jost wordmark. Gradient stop colors come from CSS tokens (theme-aware).
export function Logo() {
  return (
    <span className="logo">
      <svg className="logo-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="kernelMark" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
            <stop offset="0" className="mk-edge" />
            <stop offset="0.5" className="mk-mid" />
            <stop offset="1" className="mk-edge" />
            {/* Sheen sweep — moves the gradient diagonally for an animated shimmer. */}
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              values="-70 -70; 70 70; -70 -70"
              dur="4.5s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
        <path
          d="M50 0 L53 34 L68 3 L55 36 L90 12 L58 40 L98 38 L59 46 L100 50 L59 55 L96 68 L57 58 L88 90 L54 62 L65 98 L51 64 L50 100 L48 62 L32 96 L45 60 L8 85 L42 56 L2 65 L41 52 L0 50 L42 46 L4 35 L44 42 L12 14 L46 38 L35 5 L48 36 Z"
          fill="url(#kernelMark)"
        />
      </svg>
      <span className="logo-word">
        Kernel<span className="logo-word-accent">CMS</span>
      </span>
    </span>
  )
}
