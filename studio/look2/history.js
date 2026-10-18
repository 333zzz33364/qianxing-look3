// Transactions retain the complete authoring state, never a running VM.
export class EditHistory {
  constructor(capture, restore, limit = 80) {
    this.capture = capture
    this.restore = restore
    this.limit = limit
    this.entries = []
    this.cursor = -1
  }

  describe() {
    return {
      entries: this.entries.map(({ label, at }, index) => ({ label, at, index })),
      cursor: this.cursor,
      canUndo: this.cursor > 0,
      canRedo: this.cursor >= 0 && this.cursor < this.entries.length - 1,
    }
  }

  run(label, task) {
    const before = this.capture()
    try {
      const value = task()
      const after = this.capture()
      if (!this.entries.length) {
        this.entries.push({ label: '初始工程', at: Date.now(), state: before })
        this.cursor = 0
      }
      this.entries.splice(this.cursor + 1)
      this.entries.push({ label: String(label || '修改工程'), at: Date.now(), state: after })
      this.cursor = this.entries.length - 1
      if (this.entries.length > this.limit) {
        this.entries.shift()
        this.cursor -= 1
      }
      return value
    } catch (error) {
      this.restore(before, false)
      throw error
    }
  }

  move(action, index) {
    const next = action === 'undo' ? this.cursor - 1 : action === 'redo' ? this.cursor + 1 : Number(index)
    if (!Number.isInteger(next) || next < 0 || next >= this.entries.length) throw new Error('没有可恢复的操作记录')
    this.restore(this.entries[next].state, true)
    this.cursor = next
    return this.describe()
  }
}
