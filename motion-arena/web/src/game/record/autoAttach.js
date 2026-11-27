// Zero-edit recorder hook (QA / headless verification; the shipped wiring is the main.js snippet in
// docs/game/PLAYTEST.md). Importing this module BEFORE the game binds its motion pipeline (e.g. from a CDP
// addScriptToEvaluateOnNewDocument: `import('/src/game/record/autoAttach.js')`) patches Game.prototype.setMotion so
// the recorder is created with the game's own bus / motion / tracking at the same moment the snippet would create it.
// Only active with ?record=1 (or ?record=full). The recorder is exposed as window.blRecorder.
import { Game } from '../core/game.js';
import { createRecorder, recordingRequested } from './recorder.js';

if (recordingRequested() && !Game.prototype.setMotion.__rec) {
  const orig = Game.prototype.setMotion;
  Game.prototype.setMotion = function setMotionRec(motion) {
    const r = orig.call(this, motion);
    if (!window.blRecorder) {
      const game = this;
      window.blRecorder = createRecorder({
        motion, bus: game.ctx.bus, game, source: () => game.tracking?.source,
        getMeta: () => ({ snap: game.snapshot(), tracker: game.tracking?.kind, model: game.tracking?.source?.model }),
      });
    }
    return r;
  };
  Game.prototype.setMotion.__rec = true;
}
