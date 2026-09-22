// 도메인 카탈로그를 한 객체로 묶는다(DOCS/i18n-design.md §4.2). 새 도메인은 여기 한 줄.
//
// 접근은 언제나 **경로**로 한다 — `msg.language.fieldLabel`. `msg[domain][key]`처럼 조립하면 호출처가
// 검색에서 사라지고 오타가 런타임에만 드러난다(e2e 66 이 `msg[` 패턴을 막는다).

import type { Locale } from "./define-text";
import { languageText } from "./text-language";
import { imageEditorText } from "./text-image-editor";
import { imageInspectorText } from "./text-image-inspector";
import { imagePanelsText } from "./text-image-panels";
import { annotateText } from "./text-annotate";
import { libText } from "./text-lib";
import { settingsText } from "./text-settings";
import { shellText } from "./text-shell";
import { sysmonText } from "./text-sysmon";
import { appText } from "./text-app";
import { gitText } from "./text-git";
import { notesText } from "./text-notes";
import { apiclientText } from "./text-apiclient";
import { dbText } from "./text-db";
import { searchText } from "./text-search";
import { storesText } from "./text-stores";
import { treeText } from "./text-tree";
import { reportText } from "./text-report";
import { folderText } from "./text-folder";
import { pdfText } from "./text-pdf";
import { mediaText } from "./text-media";
import { windowsText } from "./text-windows";

export function messagesFor(locale: Locale) {
  return {
    language: languageText[locale],
    imageEditor: imageEditorText[locale],
    imageInspector: imageInspectorText[locale],
    imagePanels: imagePanelsText[locale],
    annotate: annotateText[locale],
    lib: libText[locale],
    settings: settingsText[locale],
    shell: shellText[locale],
    sysmon: sysmonText[locale],
    app: appText[locale],
    git: gitText[locale],
    notes: notesText[locale],
    apiclient: apiclientText[locale],
    db: dbText[locale],
    search: searchText[locale],
    stores: storesText[locale],
    tree: treeText[locale],
    report: reportText[locale],
    folder: folderText[locale],
    pdf: pdfText[locale],
    media: mediaText[locale],
    windows: windowsText[locale],
  };
}

export type Messages = ReturnType<typeof messagesFor>;
