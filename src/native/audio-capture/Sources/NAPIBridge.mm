#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <napi.h>

namespace {

struct AudioPayload {
  std::string source;
  std::vector<uint8_t> data;
  double timestamp;
  double durationMs;
  int sampleRate;
};

struct ErrorPayload {
  std::string code;
  std::string message;
};

Napi::ThreadSafeFunction audioCallback;
Napi::ThreadSafeFunction errorCallback;
bool audioCallbackRegistered = false;
bool errorCallbackRegistered = false;

void EmitError(const std::string& code, const std::string& message) {
  if (!errorCallbackRegistered) {
    return;
  }

  auto* payload = new ErrorPayload{code, message};
  napi_status status = errorCallback.NonBlockingCall(
      payload,
      [](Napi::Env env, Napi::Function jsCallback, ErrorPayload* payload) {
        Napi::Object error = Napi::Object::New(env);
        error.Set("code", payload->code);
        error.Set("message", payload->message);
        jsCallback.Call({error});
        delete payload;
      });

  if (status != napi_ok) {
    delete payload;
  }
}

void EmitAudio(const std::string& source,
               const std::vector<uint8_t>& data,
               double timestamp,
               double durationMs,
               int sampleRate) {
  if (!audioCallbackRegistered || data.empty()) {
    return;
  }

  auto* payload = new AudioPayload{source, data, timestamp, durationMs, sampleRate};
  napi_status status = audioCallback.NonBlockingCall(
      payload,
      [](Napi::Env env, Napi::Function jsCallback, AudioPayload* payload) {
        Napi::Object chunk = Napi::Object::New(env);
        chunk.Set("source", payload->source);
        chunk.Set("data", Napi::Buffer<uint8_t>::Copy(env, payload->data.data(), payload->data.size()));
        chunk.Set("timestamp", payload->timestamp);
        chunk.Set("durationMs", payload->durationMs);
        chunk.Set("sampleRate", payload->sampleRate);
        jsCallback.Call({chunk});
        delete payload;
      });

  if (status != napi_ok) {
    delete payload;
  }
}

double NowMilliseconds() {
  return [[NSDate date] timeIntervalSince1970] * 1000.0;
}

int16_t FloatToInt16(float sample) {
  const float clamped = std::max(-1.0f, std::min(1.0f, sample));
  return static_cast<int16_t>(std::lrintf(clamped * 32767.0f));
}

std::vector<uint8_t> ConvertPCMBufferToLinear16(AVAudioPCMBuffer* buffer, int targetSampleRate) {
  if (!buffer || buffer.frameLength == 0 || targetSampleRate <= 0) {
    return {};
  }

  const double sourceRate = buffer.format.sampleRate;
  if (sourceRate <= 0) {
    return {};
  }

  const AVAudioFrameCount sourceFrames = buffer.frameLength;
  const AVAudioChannelCount channelCount = std::max<AVAudioChannelCount>(1, buffer.format.channelCount);
  const size_t targetFrames = std::max<size_t>(1, static_cast<size_t>(std::floor(sourceFrames * targetSampleRate / sourceRate)));
  std::vector<uint8_t> output(targetFrames * sizeof(int16_t));
  auto* outputSamples = reinterpret_cast<int16_t*>(output.data());

  if (buffer.floatChannelData != nullptr) {
    float* const* channels = buffer.floatChannelData;
    for (size_t targetIndex = 0; targetIndex < targetFrames; targetIndex += 1) {
      const auto sourceIndex = std::min<AVAudioFrameCount>(
          sourceFrames - 1,
          static_cast<AVAudioFrameCount>(std::floor(targetIndex * sourceRate / targetSampleRate)));
      float mixed = 0.0f;
      for (AVAudioChannelCount channel = 0; channel < channelCount; channel += 1) {
        mixed += channels[channel][sourceIndex];
      }
      outputSamples[targetIndex] = FloatToInt16(mixed / static_cast<float>(channelCount));
    }
    return output;
  }

  if (buffer.int16ChannelData != nullptr) {
    int16_t* const* channels = buffer.int16ChannelData;
    for (size_t targetIndex = 0; targetIndex < targetFrames; targetIndex += 1) {
      const auto sourceIndex = std::min<AVAudioFrameCount>(
          sourceFrames - 1,
          static_cast<AVAudioFrameCount>(std::floor(targetIndex * sourceRate / targetSampleRate)));
      int mixed = 0;
      for (AVAudioChannelCount channel = 0; channel < channelCount; channel += 1) {
        mixed += channels[channel][sourceIndex];
      }
      outputSamples[targetIndex] = static_cast<int16_t>(mixed / static_cast<int>(channelCount));
    }
  }

  return output;
}

AVAudioPCMBuffer* PCMBufferFromSampleBuffer(CMSampleBufferRef sampleBuffer) {
  CMFormatDescriptionRef formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer);
  if (!formatDescription) {
    return nil;
  }

  const AudioStreamBasicDescription* streamDescription =
      CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription);
  if (!streamDescription) {
    return nil;
  }

  AVAudioFormat* format = [[AVAudioFormat alloc] initWithStreamDescription:streamDescription];
  if (!format) {
    return nil;
  }

  AVAudioFrameCount frameCount = static_cast<AVAudioFrameCount>(CMSampleBufferGetNumSamples(sampleBuffer));
  AVAudioPCMBuffer* pcmBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:frameCount];
  if (!pcmBuffer) {
    return nil;
  }

  pcmBuffer.frameLength = frameCount;
  OSStatus status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer,
      0,
      static_cast<int32_t>(frameCount),
      pcmBuffer.mutableAudioBufferList);

  return status == noErr ? pcmBuffer : nil;
}

}  // namespace

@interface STAudioCaptureController : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) AVAudioEngine* microphoneEngine;
@property(nonatomic, strong) SCStream* systemStream;
@property(nonatomic, strong) dispatch_queue_t systemAudioQueue;
@property(nonatomic, assign) NSInteger sampleRate;
@property(nonatomic, copy) NSString* sessionId;
- (BOOL)startWithTargetBundleId:(NSString*)targetBundleId sampleRate:(NSInteger)sampleRate error:(NSError**)error;
- (void)stop;
@end

@implementation STAudioCaptureController

- (instancetype)init {
  self = [super init];
  if (self) {
    _sampleRate = 16000;
    _sessionId = [[NSUUID UUID] UUIDString];
    _systemAudioQueue = dispatch_queue_create("app.salestalk.audio.system", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (BOOL)startWithTargetBundleId:(NSString*)targetBundleId sampleRate:(NSInteger)sampleRate error:(NSError**)error {
  self.sampleRate = sampleRate;
  BOOL microphoneStarted = [self startMicrophone:error];
  [self startSystemAudioForBundleId:targetBundleId];
  return microphoneStarted;
}

- (BOOL)startMicrophone:(NSError**)error {
  if (self.microphoneEngine && self.microphoneEngine.isRunning) {
    return YES;
  }

  self.microphoneEngine = [[AVAudioEngine alloc] init];
  AVAudioInputNode* inputNode = self.microphoneEngine.inputNode;

  if ([inputNode respondsToSelector:@selector(setVoiceProcessingEnabled:error:)]) {
    NSError* voiceProcessingError = nil;
    if (![inputNode setVoiceProcessingEnabled:YES error:&voiceProcessingError]) {
      EmitError("microphone_voice_processing_failed", voiceProcessingError.localizedDescription.UTF8String ?: "Failed to enable voice processing");
    }
  }

  AVAudioFormat* inputFormat = [inputNode outputFormatForBus:0];
  __weak STAudioCaptureController* weakSelf = self;
  [inputNode installTapOnBus:0
                  bufferSize:1600
                      format:inputFormat
                       block:^(AVAudioPCMBuffer* buffer, AVAudioTime* when) {
                         STAudioCaptureController* strongSelf = weakSelf;
                         if (!strongSelf) {
                           return;
                         }
                         std::vector<uint8_t> linear16 = ConvertPCMBufferToLinear16(buffer, static_cast<int>(strongSelf.sampleRate));
                         const double durationMs = buffer.format.sampleRate > 0
                                                       ? (static_cast<double>(buffer.frameLength) / buffer.format.sampleRate) * 1000.0
                                                       : 100.0;
                         EmitAudio("microphone", linear16, NowMilliseconds(), durationMs, static_cast<int>(strongSelf.sampleRate));
                       }];

  [self.microphoneEngine prepare];
  return [self.microphoneEngine startAndReturnError:error];
}

- (void)startSystemAudioForBundleId:(NSString*)targetBundleId {
  if (@available(macOS 13.0, *)) {
    __weak STAudioCaptureController* weakSelf = self;
    [SCShareableContent getShareableContentWithCompletionHandler:^(
                            SCShareableContent* _Nullable shareableContent,
                            NSError* _Nullable error) {
      STAudioCaptureController* strongSelf = weakSelf;
      if (!strongSelf) {
        return;
      }
      if (error) {
        EmitError("screen_capture_shareable_content_failed", error.localizedDescription.UTF8String ?: "Failed to read shareable content");
        return;
      }
      if (!shareableContent) {
        EmitError("screen_capture_content_unavailable", "ScreenCaptureKit returned no shareable content");
        return;
      }

      SCRunningApplication* targetApplication = nil;
      for (SCRunningApplication* application in shareableContent.applications) {
        if ([application.bundleIdentifier isEqualToString:targetBundleId]) {
          targetApplication = application;
          break;
        }
      }

      SCDisplay* display = shareableContent.displays.firstObject;
      if (!display) {
        EmitError("screen_capture_display_unavailable", "No display available for ScreenCaptureKit");
        return;
      }

      if (!targetApplication) {
        EmitError("screen_capture_target_not_running", targetBundleId.UTF8String ?: "Target app is not running");
        return;
      }

      SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display
                                                    includingApplications:@[ targetApplication ]
                                                       exceptingWindows:@[]];
      SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
      configuration.width = display.width;
      configuration.height = display.height;
      configuration.minimumFrameInterval = CMTimeMake(1, 5);
      configuration.queueDepth = 3;
      configuration.capturesAudio = YES;
      configuration.excludesCurrentProcessAudio = YES;
      configuration.sampleRate = strongSelf.sampleRate;
      configuration.channelCount = 1;

      strongSelf.systemStream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:strongSelf];
      NSError* addOutputError = nil;
      if (![strongSelf.systemStream addStreamOutput:strongSelf
                                               type:SCStreamOutputTypeAudio
                                  sampleHandlerQueue:strongSelf.systemAudioQueue
                                              error:&addOutputError]) {
        EmitError("screen_capture_add_audio_output_failed", addOutputError.localizedDescription.UTF8String ?: "Failed to add audio output");
        strongSelf.systemStream = nil;
        return;
      }

      [strongSelf.systemStream startCaptureWithCompletionHandler:^(NSError* _Nullable startError) {
        if (startError) {
          EmitError("screen_capture_start_failed", startError.localizedDescription.UTF8String ?: "Failed to start ScreenCaptureKit stream");
        }
      }];
    }];
  } else {
    EmitError("screen_capture_unsupported_macos", "ScreenCaptureKit requires macOS 13 or newer");
  }
}

- (void)stop {
  if (self.microphoneEngine) {
    [self.microphoneEngine.inputNode removeTapOnBus:0];
    [self.microphoneEngine stop];
    self.microphoneEngine = nil;
  }

  SCStream* stream = self.systemStream;
  self.systemStream = nil;
  if (stream) {
    [stream stopCaptureWithCompletionHandler:nil];
  }
}

- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
  if (!CMSampleBufferIsValid(sampleBuffer) || type != SCStreamOutputTypeAudio) {
    return;
  }

  AVAudioPCMBuffer* pcmBuffer = PCMBufferFromSampleBuffer(sampleBuffer);
  if (!pcmBuffer) {
    return;
  }

  std::vector<uint8_t> linear16 = ConvertPCMBufferToLinear16(pcmBuffer, static_cast<int>(self.sampleRate));
  const double durationMs = pcmBuffer.format.sampleRate > 0
                                ? (static_cast<double>(pcmBuffer.frameLength) / pcmBuffer.format.sampleRate) * 1000.0
                                : 100.0;
  EmitAudio("system", linear16, NowMilliseconds(), durationMs, static_cast<int>(self.sampleRate));
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  EmitError("screen_capture_stream_stopped", error.localizedDescription.UTF8String ?: "ScreenCaptureKit stream stopped");
}

@end

namespace {

STAudioCaptureController* controller = nil;

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  if (!info[0].IsObject()) {
    deferred.Reject(Napi::TypeError::New(env, "startCapture requires a config object").Value());
    return deferred.Promise();
  }

  Napi::Object config = info[0].As<Napi::Object>();
  std::string targetBundleId = config.Has("targetAppBundleId")
                                   ? config.Get("targetAppBundleId").As<Napi::String>().Utf8Value()
                                   : "us.zoom.xos";
  int sampleRate = config.Has("sampleRate") ? config.Get("sampleRate").As<Napi::Number>().Int32Value() : 16000;

  if (!controller) {
    controller = [[STAudioCaptureController alloc] init];
  }

  NSError* error = nil;
  BOOL started = [controller startWithTargetBundleId:[NSString stringWithUTF8String:targetBundleId.c_str()]
                                         sampleRate:sampleRate
                                              error:&error];
  if (!started) {
    std::string message = error ? error.localizedDescription.UTF8String : "Failed to start native audio capture";
    deferred.Reject(Napi::Error::New(env, message).Value());
    return deferred.Promise();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", std::string(controller.sessionId.UTF8String));
  deferred.Resolve(result);
  return deferred.Promise();
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  if (controller) {
    [controller stop];
    controller = nil;
  }
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

Napi::Value OnAudioChunk(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsFunction()) {
    throw Napi::TypeError::New(env, "onAudioChunk requires a callback");
  }

  if (audioCallbackRegistered) {
    audioCallback.Release();
    audioCallbackRegistered = false;
  }
  audioCallback = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "sales-talk-audio-chunk",
      0,
      1);
  audioCallbackRegistered = true;
  return env.Undefined();
}

Napi::Value OnError(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsFunction()) {
    throw Napi::TypeError::New(env, "onError requires a callback");
  }

  if (errorCallbackRegistered) {
    errorCallback.Release();
    errorCallbackRegistered = false;
  }
  errorCallback = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "sales-talk-audio-error",
      0,
      1);
  errorCallbackRegistered = true;
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("onAudioChunk", Napi::Function::New(env, OnAudioChunk));
  exports.Set("onError", Napi::Function::New(env, OnError));
  return exports;
}

}  // namespace

NODE_API_MODULE(audio_capture, Init)
