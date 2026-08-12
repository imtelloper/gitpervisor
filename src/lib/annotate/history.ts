// 편집 히스토리 — EditorDoc 스냅샷 스택(§5.3).
//
// **문서 전체**를 스냅샷한다. 회전이 주석 기하를 변형하므로(§3.2) 주석만 되돌리면 좌표 공간이
// 어긋난다. 이미지 픽셀은 문서에 없고 객체는 불변 갱신이므로(변경분만 새 참조) 스냅샷 50장의
// 실제 메모리 비용은 무시할 만하다.

import type { EditorDoc } from "./types";

/** 스냅샷 상한. 초과하면 가장 오래된 것부터 버린다. */
export const HISTORY_LIMIT = 50;

/**
 * undo/redo 스택. 커밋 시점(pointerup, 텍스트 확정, 삭제, z-order, 복제, 회전/반전,
 * 크롭 확정, 슬라이더 onPointerUp)에만 `commit()` 을 부른다 — 드래그 중 매 틱이 아니다.
 */
export class DocHistory {
  private past: EditorDoc[] = [];
  private future: EditorDoc[] = [];
  private current: EditorDoc;

  constructor(initial: EditorDoc) {
    this.current = initial;
  }

  /** 현재 문서. */
  get present(): EditorDoc {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** 디버깅·테스트용 스택 깊이. */
  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  /**
   * 새 커밋. 직전 문서를 undo 스택에 쌓고 redo 스택을 버린다(분기 히스토리는 만들지 않는다).
   */
  commit(next: EditorDoc): void {
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > HISTORY_LIMIT) {
      this.past.splice(0, this.past.length - HISTORY_LIMIT);
    }
    this.future = [];
    this.current = next;
  }

  /**
   * 스냅샷 없이 현재 문서만 교체한다(드래그 중 라이브 갱신처럼 커밋이 아닌 변경).
   * undo/redo 스택은 건드리지 않는다.
   */
  replace(next: EditorDoc): void {
    this.current = next;
  }

  /** 한 단계 되돌린다. 되돌릴 것이 없으면 null. */
  undo(): EditorDoc | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.current);
    this.current = prev;
    return prev;
  }

  /** 되돌린 것을 다시 적용한다. 없으면 null. */
  redo(): EditorDoc | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  /** 새 이미지를 열 때처럼 히스토리를 통째로 초기화한다. */
  reset(doc: EditorDoc): void {
    this.past = [];
    this.future = [];
    this.current = doc;
  }
}
