// design-sync extra entry: exports merged onto the DS window global alongside
// components/ui. MotionProvider is the app's root LazyMotion wrapper — Sheet
// and EditorDialog render `m.*` motion components and need it as the preview
// provider (cfg.provider).
export { default as MotionProvider } from '../web/components/MotionProvider';
// sonner's imperative `toast` must ride the SAME module instance as the
// bundled <Toaster/> — designs (and the Toaster preview) can only reach that
// store through the bundle, so re-export it here.
export { toast } from 'sonner';
