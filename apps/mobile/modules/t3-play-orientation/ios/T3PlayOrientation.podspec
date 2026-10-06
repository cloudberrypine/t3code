Pod::Spec.new do |s|
  s.name           = 'T3PlayOrientation'
  s.version        = '1.0.0'
  s.summary        = 'Lets the Polyzonia play screen rotate on iPhone.'
  s.description    = 'Widens the app orientation mask while the play screen is open.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
