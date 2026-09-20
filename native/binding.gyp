# node-gyp build for the native Needle 3 addon.
#
# Links the needle-rs C ABI shared library (native/lib/libneedle_c.so) built by
# cargo. The addon lands in native/build/Release/, so the runtime rpath is
# $ORIGIN/../../lib -> native/lib/ where the .so is vendored.
{
  "targets": [
    {
      "target_name": "native",
      "sources": [ "binding.cc" ],
      "include_dirs": [
        "<(module_root_dir)/../node_modules/node-addon-api",
        "<(module_root_dir)/include"
      ],
      # Enable C++ exceptions so errors throw as JavaScript exceptions.
      # node-gyp's node config disables them (see common.gypi); override via
      # cflags_cc! and re-add the C++17 standard.
      "defines": [ "NAPI_VERSION=8", "NODE_ADDON_API_CPP_EXCEPTIONS" ],
      "cflags_cc": [ "-std=gnu++17", "-fexceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      # Link against the vendored needle-c shared library.
      "libraries": [
        "-L<(module_root_dir)/lib",
        "-lneedle_c"
      ],
      # Find libneedle_c.so next to the addon at load time.
      # $$ -> $ for make; single quotes keep the shell from expanding $ORIGIN
      # at build time so the loader expands it at runtime ($ORIGIN = build/Release/).
      "ldflags": [
        "-Wl,-rpath,'$$ORIGIN/../../lib'"
      ]
    }
  ]
}
