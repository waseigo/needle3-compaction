// Native Needle 3 bindings for needle3-compaction.
//
// Wraps the needle-rs `needle-c` C ABI (see native/include/needle.h) so the
// TypeScript engine can drive the fast native x64 build instead of the WASM
// runtime. Ownership of Rust-allocated memory is handled explicitly: the model
// handle is freed with needle_v3_free() on GC (via a finalizer), and the heap
// strings returned by run/run_json are copied into a Node Buffer and released
// with needle_free_str() — copying keeps the freed pointer Rust-owned.
//
// C++ exceptions are enabled (see binding.gyp) so argument errors and Rust
// failures surface as JavaScript exceptions via the usual throw path.
#include <napi.h>
#include <cstring>
#include <string>
#include "needle.h"

namespace {

// Copy a heap string returned by the Rust side into a Node Buffer, then release
// the Rust allocation. Copying keeps the bytes owned by JS so the pointer handed
// to needle_free_str() is always the one Rust allocated, never a JS-owned copy.
Napi::Buffer<uint8_t> CopyAndFree(Napi::Env env, char* ptr) {
  if (ptr == nullptr) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  size_t len = std::strlen(ptr);
  Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(env, len);
  std::memcpy(buf.Data(), ptr, len);
  needle_free_str(ptr);
  return buf;
}

Napi::String BufferToString(Napi::Env env, const Napi::Buffer<uint8_t>& buf) {
  return Napi::String::New(
      env, std::string(reinterpret_cast<char*>(buf.Data()), buf.ByteLength()));
}

// Require exactly `n` string arguments. The `n > 2` guard short-circuits before
// info[2] is read, so a 2-arg call never indexes past the argument list.
void RequireStrings(Napi::Env env, const Napi::CallbackInfo& info, size_t n) {
  if (info.Length() != n ||
      !info[0].IsString() || !info[1].IsString() ||
      (n > 2 && !info[2].IsString())) {
    throw Napi::TypeError::New(env, "expected (string, string[, string])");
  }
}

}  // namespace

Napi::Value Load(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() != 1 || !info[0].IsTypedArray()) {
    throw Napi::TypeError::New(env, "load(bytes) expects a single Uint8Array");
  }
  Napi::Buffer<uint8_t> arr = info[0].As<Napi::Buffer<uint8_t>>();
  NeedleV3Handle* handle = needle_v3_load_bytes(
      reinterpret_cast<const unsigned char*>(arr.Data()), arr.ByteLength());
  if (handle == nullptr) {
    // Bad bytes / unsupported container: return null so the caller can fall
    // back to the WASM runtime instead of crashing.
    return env.Null();
  }

  Napi::Object obj = Napi::Object::New(env);

  // Free the model handle when the JS object is collected. The method closures
  // below capture the handle, so they keep it alive for the object's lifetime
  // and this never fires while the engine is in use.
  obj.AddFinalizer(
      [](Napi::Env /*env*/, void* data) {
        needle_v3_free(static_cast<NeedleV3Handle*>(data));
      },
      handle);

  auto run = [handle](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    RequireStrings(env, info, 2);
    Napi::String query = info[0].As<Napi::String>();
    Napi::String tools = info[1].As<Napi::String>();
    std::string q = query.Utf8Value();
    std::string t = tools.Utf8Value();
    char* out = needle_v3_run(handle, q.c_str(), t.c_str());
    if (out == nullptr) {
      const char* err = needle_last_error();
      throw Napi::Error::New(env, err ? err : "needle_v3_run failed");
    }
    return BufferToString(env, CopyAndFree(env, out));
  };

  auto runJson = [handle](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    RequireStrings(env, info, 2);
    Napi::String query = info[0].As<Napi::String>();
    Napi::String tools = info[1].As<Napi::String>();
    std::string q = query.Utf8Value();
    std::string t = tools.Utf8Value();
    char* out = needle_v3_run_json(handle, q.c_str(), t.c_str());
    if (out == nullptr) {
      const char* err = needle_last_error();
      throw Napi::Error::New(env, err ? err : "needle_v3_run_json failed");
    }
    return BufferToString(env, CopyAndFree(env, out));
  };

  auto confidenceFor = [handle](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    RequireStrings(env, info, 3);
    Napi::String query = info[0].As<Napi::String>();
    Napi::String tools = info[1].As<Napi::String>();
    Napi::String completion = info[2].As<Napi::String>();
    std::string q = query.Utf8Value();
    std::string t = tools.Utf8Value();
    std::string c = completion.Utf8Value();
    float out = 0.0f;
    bool ok = needle_v3_confidence_for(handle, q.c_str(), t.c_str(), c.c_str(), &out);
    if (!ok) {
      return env.Null();  // this container carries no confidence head
    }
    return Napi::Number::New(env, static_cast<double>(out));
  };

  auto maxSeqLen = [handle](const Napi::CallbackInfo& info) -> Napi::Value {
    return Napi::Number::New(
        info.Env(), static_cast<double>(needle_v3_max_seq_len(handle)));
  };

  obj.Set("run", Napi::Function::New(env, run, "run"));
  obj.Set("runJson", Napi::Function::New(env, runJson, "runJson"));
  obj.Set("confidenceFor", Napi::Function::New(env, confidenceFor, "confidenceFor"));
  obj.Set("maxSeqLen", Napi::Function::New(env, maxSeqLen, "maxSeqLen"));
  return obj;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("load", Napi::Function::New(env, Load, "load"));
  return exports;
}

NODE_API_MODULE(native, Init)
