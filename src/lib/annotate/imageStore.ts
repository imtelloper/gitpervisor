// 이미지 페인트 소스 디코드 캐시 — `doc.assets` 의 base64 를 ImageBitmap 으로 풀어 둔다(태스크 39 §3.6).
//
// 왜 문서 밖에 두는가: `EditorDoc` 은 히스토리에 통째로 스냅샷된다(types.ts 머리말). 디코드본을
// 문서 안에 넣으면 되돌리기 200벌(태스크 41)이 같은 비트맵을 200번 붙든다. 그래서 캐시는
// **`doc.assets` 객체 참조를 키로 한 WeakMap** 에 얹는다 — 조정 슬라이더처럼 assets 를 건드리지
// 않는 편집은 참조가 그대로라 캐시가 살아 있고, 문서가 사라지면 캐시도 함께 수거된다.
// (에셋을 추가하면 assets 가 새 객체가 되므로 캐시도 새로 시작한다. 삽입은 드물다.)
//
// 렌더는 동기다. 그래서 `get` 은 **지금 있는 것만** 돌려주고(없으면 회색 플레이스홀더가 나간다),
// 저장·내보내기는 `ensureAssets(doc)` 를 await 한 뒤에 렌더한다(39 §4·태스크 52 계약).

import { loadImage } from "../image-codec";
import type { AssetId, EditorDoc } from "./types";

type Assets = EditorDoc["assets"];

export interface ImageStore {
  get(assetId: AssetId): ImageBitmap | null;
  ensure(doc: EditorDoc): Promise<void>;
}

/** 디코드가 끝난 비트맵. */
const decoded = new WeakMap<Assets, Map<AssetId, ImageBitmap>>();
/**
 * 진행 중이거나 이미 끝난 디코드 작업.
 *
 * 실패한 작업도 **지우지 않는다** — 렌더가 매 프레임 `get` 을 부르므로, 실패를 지우면
 * 깨진 에셋 하나가 프레임마다 디코드를 새로 띄우는 폭풍이 된다.
 */
const tasks = new WeakMap<Assets, Map<AssetId, Promise<void>>>();

function mapOf<V>(store: WeakMap<Assets, Map<AssetId, V>>, assets: Assets): Map<AssetId, V> {
  let m = store.get(assets);
  if (!m) {
    m = new Map<AssetId, V>();
    store.set(assets, m);
  }
  return m;
}

/**
 * 에셋 하나를 디코드한다. 같은 에셋에 대해서는 **항상 같은 Promise** 를 돌려준다.
 *
 * 틀리면: 같은 이미지를 프레임마다 다시 디코드해 4K 페인트 하나가 GC 를 계속 튀게 한다.
 */
function decodeAsset(assets: Assets, id: AssetId): Promise<void> {
  const running = mapOf(tasks, assets);
  const started = running.get(id);
  if (started) return started;
  const task = (async () => {
    const a = assets[id];
    if (!a || !a.data) return;
    // 태스크 41 이 담는 값은 raw base64 다. 이미 data URL 이면 그대로 쓴다(둘 다 받는다).
    const src = a.data.startsWith("data:") ? a.data : `data:${a.mime};base64,${a.data}`;
    try {
      // CSP 가 `connect-src` 에 data: 를 안 열어 둬 fetch 로는 못 읽는다(tauri.conf.json:15).
      // img 태그 경로(`img-src ... data:`)를 쓰는 기존 헬퍼를 그대로 재사용한다.
      const img = await loadImage(src);
      mapOf(decoded, assets).set(id, await createImageBitmap(img));
    } catch {
      console.warn(`[annotate] 이미지 에셋을 디코드하지 못했습니다: ${id}`);
    }
  })();
  running.set(id, task);
  return task;
}

/**
 * `doc.assets` 위의 디코드 캐시 핸들. 문서마다 새로 불러도 **같은 캐시**를 본다(비용 0).
 *
 * 틀리면: `get` 이 매번 null 을 돌려줘 이미지 페인트가 영원히 회색 판으로 남는다.
 */
export function imageStore(doc: EditorDoc): ImageStore {
  const assets = doc.assets;
  return {
    get(id) {
      const bmp = decoded.get(assets)?.get(id);
      if (bmp) return bmp;
      // 여기서 디코드를 띄워 두면 **다음 프레임**에 진짜 그림이 나온다(포인터 이동·선택마다
      // 재렌더가 돈다). 출력은 이 왕복을 기다릴 수 없으므로 ensureAssets 를 먼저 await 한다.
      if (assets[id]) void decodeAsset(assets, id);
      return null;
    },
    ensure: (d) => ensureAssets(d),
  };
}

/**
 * 문서가 든 에셋 전부가 디코드될 때까지 기다린다. `renderOutput`·내보내기(태스크 40·52)는
 * 이걸 await 한 뒤에 렌더해야 한다.
 *
 * 틀리면: 회색 플레이스홀더가 저장 파일에 그대로 굳는다(되돌릴 수 없는 손실).
 */
export function ensureAssets(doc: EditorDoc): Promise<void> {
  const assets = doc.assets;
  const ids = Object.keys(assets) as AssetId[];
  if (ids.length === 0) return Promise.resolve();
  return Promise.all(ids.map((id) => decodeAsset(assets, id))).then(() => undefined);
}
