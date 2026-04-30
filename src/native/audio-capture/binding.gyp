{
  "targets": [
    {
      "target_name": "audio_capture",
      "sources": ["Sources/NAPIBridge.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS=0"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fexceptions"],
        "OTHER_LDFLAGS": [
          "-framework Foundation",
          "-framework AVFoundation",
          "-framework CoreMedia",
          "-framework ScreenCaptureKit"
        ]
      }
    }
  ]
}
