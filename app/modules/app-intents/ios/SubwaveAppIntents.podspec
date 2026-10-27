Pod::Spec.new do |s|
  s.name           = 'SubwaveAppIntents'
  s.version        = '1.0.0'
  s.summary        = 'The app half of the SUB/WAVE App Intents bridge'
  s.description    = 'Hands Siri, Shortcuts and Control requests to JS and posts the answer back to the waiting intent.'
  s.author         = 'SUB/WAVE'
  s.homepage       = 'https://www.getsubwave.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,swift}'
end
