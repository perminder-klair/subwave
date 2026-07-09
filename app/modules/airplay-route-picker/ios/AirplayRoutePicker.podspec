Pod::Spec.new do |s|
  s.name           = 'AirplayRoutePicker'
  s.version        = '1.0.0'
  s.summary        = 'In-app AirPlay route picker button (AVRoutePickerView)'
  s.description    = 'Thin Expo module wrapping AVRoutePickerView for the SUB/WAVE player.'
  s.author         = 'SUB/WAVE'
  s.homepage       = 'https://www.getsubwave.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,swift}'
end
