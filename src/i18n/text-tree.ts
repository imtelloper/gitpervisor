// 파일 트리.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  dir: {
    loadFailed: "불러오지 못함",
    empty: "비어 있음",
  },
  nameValidation: {
    required: "이름을 입력하세요",
    hasSeparator: "이름에 경로 구분자를 쓸 수 없습니다",
    invalid: "잘못된 이름입니다",
  },
  toast: {
    executed: (name: string) => `${name} 실행됨`,
    moved: (n: number, dest: string) => `${n}개 이동됨 → ${dest}`,
    moveFailed: (n: number, first: string, more: boolean) =>
      `이동 실패 ${n}개 — ${first}${more ? " 외" : ""}`,
    converted: (name: string, note: string) => `변환됨 — ${name}${note}`,
    batchConvertedWithConflicts: (ok: number, held: number, dup: number, fail: number) =>
      `변환 ${ok}개 완료 · 기존 파일 ${held}개 보류${dup ? `, 이름 충돌 ${dup}개 건너뜀` : ""}${fail ? `, 실패 ${fail}` : ""}`,
    batchConverted: (ok: number, dup: number, fail: number) =>
      `변환 ${ok}개 완료${dup ? `, 이름 충돌 ${dup}개 건너뜀` : ""}${fail ? `, 실패 ${fail}` : ""}`,
    batchOverwritten: (n: number) => `덮어쓰기 ${n}개 완료`,
    copyPathDone: "경로를 복사했습니다",
    copyRelPathDone: "상대 경로를 복사했습니다",
    copyNameDone: "파일 이름을 복사했습니다",
  },
  /** 드래그 이동 — 대상이 루트일 때의 이름. */
  moveDestRoot: "루트",
  dragItemCount: (n: number) => `${n}개 항목`,
  dialog: {
    createIn: (dir: string) => `${dir} 안에 만듭니다`,
    createInRoot: "프로젝트 루트에 만듭니다",
    folderNamePlaceholder: "폴더 이름",
    fileNamePlaceholder: "파일 이름",
    fileNamePlaceholderExample: "파일 이름 (예: main.py)",
    create: "만들기",
    deleteTitle: (isDir: boolean) => `${isDir ? "폴더" : "파일"} 삭제`,
    deleteMessage: (name: string) => `'${name}'을(를) 삭제할까요? 되돌릴 수 없습니다.`,
    renameTitle: (isDir: boolean) => `${isDir ? "폴더" : "파일"} 이름 바꾸기`,
    renameConfirm: "바꾸기",
    overwriteTitle: "덮어쓰기",
    overwriteMessage: (name: string) => `'${name}' 파일이 이미 있습니다. 덮어쓸까요?`,
    batchOverwriteMessage: (n: number) => `이미 있는 파일 ${n}개를 모두 덮어쓸까요?`,
    overwriteAll: "모두 덮어쓰기",
  },
  convert: {
    imageSizeUnknown: "이미지 크기를 확인할 수 없습니다",
    canvasContextFailed: "캔버스 컨텍스트를 얻지 못했습니다",
    gifFirstFrameNote: " (첫 프레임)",
  },
  header: {
    newFileRootTitle: "새 파일 (루트)",
    newFolderRootTitle: "새 폴더 (루트)",
    close: "닫기",
    collapsePanel: "패널 접기",
  },
  menu: {
    newFile: "새 파일",
    newFolder: "새 폴더",
    run: "실행하기",
    openInNewWindow: "새 창으로 열기",
    selectedImages: (n: number) => `선택한 이미지 ${n}개`,
    batchConvertTo: (format: string) => `${format}(으)로 일괄 변환`,
    openInBrowser: "브라우저로 열기",
    editImage: "이미지 편집",
    convertTo: (format: string) => `${format}(으)로 변환`,
    setAsLogo: "프로젝트 로고로 지정",
    rename: "이름 바꾸기",
    delete: "삭제",
    copyPath: "경로 복사",
    copyRelPath: "상대 경로 복사",
    copyName: "이름 복사",
  },
};

export const treeText = defineText(ko, {
  en: {
    dir: {
      loadFailed: "Couldn't load",
      empty: "Empty",
    },
    nameValidation: {
      required: "Enter a name",
      hasSeparator: "Names can't contain path separators",
      invalid: "Invalid name",
    },
    toast: {
      executed: (name) => `Launched ${name}`,
      moved: (n, dest) => `Moved ${n} ${plural(n, "item", "items")} → ${dest}`,
      moveFailed: (n, first, more) =>
        `Couldn't move ${n} ${plural(n, "item", "items")} — ${first}${more ? " and more" : ""}`,
      converted: (name, note) => `Converted — ${name}${note}`,
      batchConvertedWithConflicts: (ok, held, dup, fail) =>
        `Converted ${ok} · ${held} existing ${plural(held, "file", "files")} on hold${dup ? `, skipped ${dup} name ${plural(dup, "conflict", "conflicts")}` : ""}${fail ? `, ${fail} failed` : ""}`,
      batchConverted: (ok, dup, fail) =>
        `Converted ${ok} ${plural(ok, "image", "images")}${dup ? `, skipped ${dup} name ${plural(dup, "conflict", "conflicts")}` : ""}${fail ? `, ${fail} failed` : ""}`,
      batchOverwritten: (n) => `Overwrote ${n} ${plural(n, "file", "files")}`,
      copyPathDone: "Path copied",
      copyRelPathDone: "Relative path copied",
      copyNameDone: "File name copied",
    },
    moveDestRoot: "root",
    dragItemCount: (n) => `${n} ${plural(n, "item", "items")}`,
    dialog: {
      createIn: (dir) => `Create in ${dir}`,
      createInRoot: "Create in the project root",
      folderNamePlaceholder: "Folder name",
      fileNamePlaceholder: "File name",
      fileNamePlaceholderExample: "File name (e.g. main.py)",
      create: "Create",
      deleteTitle: (isDir) => `Delete ${isDir ? "folder" : "file"}`,
      deleteMessage: (name) => `Delete '${name}'? This cannot be undone.`,
      renameTitle: (isDir) => `Rename ${isDir ? "folder" : "file"}`,
      renameConfirm: "Rename",
      overwriteTitle: "Overwrite",
      overwriteMessage: (name) => `'${name}' already exists. Overwrite it?`,
      batchOverwriteMessage: (n) => `Overwrite all ${n} existing ${plural(n, "file", "files")}?`,
      overwriteAll: "Overwrite all",
    },
    convert: {
      imageSizeUnknown: "Couldn't determine the image size",
      canvasContextFailed: "Couldn't get a canvas context",
      gifFirstFrameNote: " (first frame)",
    },
    header: {
      newFileRootTitle: "New file (root)",
      newFolderRootTitle: "New folder (root)",
      close: "Close",
      collapsePanel: "Collapse panel",
    },
    menu: {
      newFile: "New file",
      newFolder: "New folder",
      run: "Run",
      openInNewWindow: "Open in new window",
      selectedImages: (n) => `${n} selected ${plural(n, "image", "images")}`,
      batchConvertTo: (format) => `Convert all to ${format}`,
      openInBrowser: "Open in browser",
      editImage: "Edit image",
      convertTo: (format) => `Convert to ${format}`,
      setAsLogo: "Set as project logo",
      rename: "Rename",
      delete: "Delete",
      copyPath: "Copy path",
      copyRelPath: "Copy relative path",
      copyName: "Copy name",
    },
  },
});
