import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * Alexa mark from public/icons/amazon-alexa-1.svg.
 *
 * It stays inline so the mark follows the active tab/sidebar text color. The
 * downloaded asset is kept as the source file; inlining the path also avoids
 * the fixed black fill disappearing on the dark active-tab background.
 */
const AlexaIcon = forwardRef<SVGSVGElement, LucideProps>(function AlexaIcon(
  {
    color = 'currentColor',
    size = 16,
    className,
    ...props
  },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M12 2C10.0222 2 8.08879 2.58649 6.4443 3.6853C4.79981 4.78412 3.51809 6.3459 2.76121 8.17317C2.00433 10.0004 1.8063 12.0111 2.19215 13.9509C2.578 15.8907 3.53041 17.6725 4.92894 19.0711C6.32746 20.4696 8.10929 21.422 10.0491 21.8079C11.9889 22.1937 13.9996 21.9957 15.8268 21.2388C17.6541 20.4819 19.2159 19.2002 20.3147 17.5557C21.4135 15.9112 22 13.9778 22 12C22 10.6868 21.7413 9.38642 21.2388 8.17317C20.7363 6.95991 19.9997 5.85752 19.0711 4.92893C18.1425 4.00035 17.0401 3.26375 15.8268 2.7612C14.6136 2.25866 13.3132 2 12 2ZM10.43 21.87V19.87C10.4197 19.5322 10.3124 19.2046 10.1209 18.9262C9.92935 18.6478 9.66174 18.4304 9.35 18.3C8.2118 17.8208 7.2248 17.0421 6.49405 16.0465C5.76331 15.051 5.31615 13.8759 5.20019 12.6464C5.08422 11.4169 5.30378 10.179 5.83549 9.06437C6.3672 7.94974 7.19117 7.00014 8.21972 6.31661C9.24826 5.63309 10.4429 5.24122 11.6764 5.18272C12.91 5.12421 14.1364 5.40126 15.225 5.98438C16.3136 6.56749 17.2237 7.43485 17.8585 8.49415C18.4934 9.55345 18.8291 10.765 18.83 12C18.83 16.43 15.39 20.61 10.43 21.87Z" />
    </svg>
  );
});

AlexaIcon.displayName = 'AlexaIcon';

export default AlexaIcon;
