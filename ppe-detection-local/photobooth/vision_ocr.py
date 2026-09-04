"""On-device text recognition via Apple's Vision framework.

recognize_text(bgr) -> list of recognized strings, best-first. Handles both
printed and handwritten text.
"""

import cv2
import Vision
from Foundation import NSData


def recognize_text(bgr_image, min_confidence=0.3):
    ok, jpg = cv2.imencode(".jpg", bgr_image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return []
    data = NSData.dataWithBytes_length_(jpg.tobytes(), len(jpg))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(False)  # names aren't dictionary words
    success, _ = handler.performRequests_error_([request], None)
    if not success or request.results() is None:
        return []
    out = []
    for obs in request.results():
        cand = obs.topCandidates_(1)
        if cand and len(cand) and cand[0].confidence() >= min_confidence:
            out.append(str(cand[0].string()))
    return out


if __name__ == "__main__":
    import sys
    img = cv2.imread(sys.argv[1])
    print(recognize_text(img))
