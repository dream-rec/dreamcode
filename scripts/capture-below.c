#include <ApplicationServices/ApplicationServices.h>
#include <CoreServices/CoreServices.h>
#include <ImageIO/ImageIO.h>
#include <stdlib.h>
#include <string.h>

static CGWindowID findWindow(pid_t ownerPid) {
  CGWindowID ownWindow = kCGNullWindowID;
  CGWindowListOption options =
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
  CFArrayRef windows =
      CGWindowListCopyWindowInfo(options, kCGNullWindowID);
  if (!windows) return ownWindow;

  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef info = CFArrayGetValueAtIndex(windows, index);
    CFNumberRef pidValue = CFDictionaryGetValue(info, kCGWindowOwnerPID);
    CFNumberRef idValue = CFDictionaryGetValue(info, kCGWindowNumber);
    pid_t pid = 0;
    CGWindowID windowId = kCGNullWindowID;

    if (pidValue && idValue &&
        CFNumberGetValue(pidValue, kCFNumberIntType, &pid) &&
        CFNumberGetValue(idValue, kCFNumberIntType, &windowId) &&
        pid == ownerPid) {
      ownWindow = windowId;
      break;
    }
  }

  CFRelease(windows);
  return ownWindow;
}

static bool writePng(CGImageRef image, const char *path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
  if (!url) return false;

  CFStringRef pngType = CFSTR("public.png");
  CGImageDestinationRef destination =
      CGImageDestinationCreateWithURL(url, pngType, 1, NULL);
  if (!destination) {
    CFRelease(url);
    return false;
  }

  CGImageDestinationAddImage(destination, image, NULL);
  bool success = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  CFRelease(url);
  return success;
}

int main(int argc, char **argv) {
  if (argc != 3) return 1;

  pid_t ownerPid = (pid_t)strtol(argv[1], NULL, 10);
  CGWindowID ownWindow = findWindow(ownerPid);
  if (ownWindow == kCGNullWindowID) return 2;

  CGImageRef image = CGWindowListCreateImage(
      CGDisplayBounds(CGMainDisplayID()),
      kCGWindowListOptionOnScreenBelowWindow,
      ownWindow,
      kCGWindowImageBestResolution);
  if (!image) return 3;

  bool success = writePng(image, argv[2]);
  CGImageRelease(image);
  return success ? 0 : 4;
}
