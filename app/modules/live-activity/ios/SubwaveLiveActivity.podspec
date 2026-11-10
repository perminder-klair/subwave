Pod::Spec.new do |s|
  s.name           = 'SubwaveLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'Live Activity control for the SUB/WAVE on-air card'
  s.description    = 'Starts, updates and ends the ActivityKit Live Activity rendered by the live-activity widget target.'
  s.author         = 'SUB/WAVE'
  s.homepage       = 'https://www.getsubwave.com'
  # ActivityKit's ActivityAttributes is iOS 16.1+, and this module stores one
  # as a property, so the floor is the app's own deployment target rather than
  # the 15.1 the other local modules use.
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,swift}'
end
