import type { SceneManifest } from "@changan/shared";

function deepClone(manifest: SceneManifest): SceneManifest {
  return JSON.parse(JSON.stringify(manifest));
}

export interface UndoRedoManagerOptions {
  initial: SceneManifest;
  maxSize?: number;
}

export class UndoRedoManager {
  private undoStack: SceneManifest[] = [];
  private redoStack: SceneManifest[] = [];
  private current: SceneManifest;
  private maxSize: number;

  constructor({ initial, maxSize = 50 }: UndoRedoManagerOptions) {
    this.current = deepClone(initial);
    this.maxSize = maxSize;
  }

  getCurrent(): SceneManifest {
    return this.current;
  }

  /**
   * Call when the user has made a change. Pushes previous state to undo stack.
   */
  recordChange(newManifest: SceneManifest): void {
    const prev = this.current;
    if (JSON.stringify(prev) === JSON.stringify(newManifest)) return; // no change
    this.undoStack.push(prev);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
    this.current = deepClone(newManifest);
  }

  /**
   * Restore from undo. Returns manifest to apply, or null if nothing to undo.
   */
  undo(): SceneManifest | null {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop()!;
    return deepClone(this.current);
  }

  /**
   * Restore from redo. Returns manifest to apply, or null if nothing to redo.
   */
  redo(): SceneManifest | null {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop()!;
    return deepClone(this.current);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Reset history (e.g. on load from file). Updates current without recording.
   */
  reset(manifest: SceneManifest): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = deepClone(manifest);
  }
}
