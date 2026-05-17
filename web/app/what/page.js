import WhatPage from '../../components/WhatPage';

export const metadata = {
  title: 'What is SUB/WAVE — Inside the station',
  description:
    'A feature story on SUB/WAVE: a personal internet radio station with an LLM-driven DJ, live song requests, and a full operator console.',
};

// Fixed app-shell layout — lock out pinch-zoom on mobile. Merges with root.
export const viewport = {
  maximumScale: 1,
  userScalable: false,
};

export default function WhatRoutePage() {
  return <WhatPage />;
}
