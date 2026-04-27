type LookupRow<TCode extends string> = { id: number; code: TCode; label: string }

export class LookupRegistry<TCode extends string = string> {
  private byCode: Map<TCode, LookupRow<TCode>>
  private byId:   Map<number, LookupRow<TCode>>

  constructor(rows: LookupRow<TCode>[]) {
    this.byCode = new Map(rows.map(r => [r.code, r]))
    this.byId   = new Map(rows.map(r => [r.id,   r]))
  }

  id(code: TCode): number {
    const row = this.byCode.get(code)
    if (!row) throw new Error(`LookupRegistry: unknown code "${code}". Valid: ${[...this.byCode.keys()].join(', ')}`)
    return row.id
  }

  label(code: TCode): string {
    const row = this.byCode.get(code)
    if (!row) throw new Error(`LookupRegistry: unknown code "${code}"`)
    return row.label
  }

  code(id: number): TCode {
    const row = this.byId.get(id)
    if (!row) throw new Error(`LookupRegistry: unknown id ${id}`)
    return row.code
  }

  all(): LookupRow<TCode>[] {
    return [...this.byCode.values()]
  }
}
