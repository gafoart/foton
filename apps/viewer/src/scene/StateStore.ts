import type { ViewMode } from "@changan/shared";

export interface ViewerState {
  modelId: string;
  /** Active accessory (attachment) id, or null for the bare base vehicle. */
  accessoryId: string | null;
  viewMode: ViewMode;
}

type Listener = (state: ViewerState) => void;

export class StateStore {
  private state: ViewerState;
  private listeners: Set<Listener> = new Set();

  constructor(initial: ViewerState) {
    this.state = { ...initial };
  }

  getState(): ViewerState {
    return { ...this.state };
  }

  setModel(modelId: string): void {
    if (this.state.modelId === modelId) return;
    this.state.modelId = modelId;
    this.emit();
  }

  /** Select an accessory (attachment) or `null` for base-only. */
  setAccessory(accessoryId: string | null): void {
    if (this.state.accessoryId === accessoryId) return;
    this.state.accessoryId = accessoryId;
    this.emit();
  }

  setViewMode(viewMode: ViewMode): void {
    if (this.state.viewMode === viewMode) return;
    this.state.viewMode = viewMode;
    this.emit();
  }

  update(partial: Partial<ViewerState>): void {
    let changed = false;
    if (partial.modelId !== undefined && this.state.modelId !== partial.modelId) {
      this.state.modelId = partial.modelId;
      changed = true;
    }
    if (
      partial.accessoryId !== undefined &&
      this.state.accessoryId !== partial.accessoryId
    ) {
      this.state.accessoryId = partial.accessoryId;
      changed = true;
    }
    if (
      partial.viewMode !== undefined &&
      this.state.viewMode !== partial.viewMode
    ) {
      this.state.viewMode = partial.viewMode;
      changed = true;
    }
    if (changed) this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
