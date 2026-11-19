//! OS 파일 유형 — Linux. GIO 콘텐츠 유형(shared-mime-info)에서 설명("PDF 문서")과 아이콘을 얻고, 아이콘은 지금 데스크톱
//! 테마(GTK IconTheme)에서 원하는 크기로 그린다 — 파일 관리자(Nautilus 등)와 같은 출처다.
//! **GTK 메인 스레드에서 부른다**(`IconTheme::default` 가 그걸 요구한다 — `os_file_type.rs`).
//! 이 파일을 고치면 Windows 개발기에서도 `bash scripts/check-os-file-type-cross.sh` 로 형식 검사한다. 실기 동작은 Linux 에서 봐야 한다.

use std::path::PathBuf;

use gtk::gio;
use gtk::prelude::*;

use super::{OsTypeFound, OsTypeKind};

pub(super) fn lookup_batch(asks: &[(PathBuf, OsTypeKind)], px: u32) -> Vec<OsTypeFound> {
    let theme = gtk::IconTheme::default();
    asks.iter()
        .map(|(path, kind)| {
            // 이름으로만 짐작한다(내용은 안 읽는다). 파일마다 아이콘이 다른 유형(.desktop 의 Icon 키)은 따로 읽지 않는다 —
            // 다운로드·스크린샷 폴더에선 드물고, 그 경우에도 "데스크톱 항목" 유형 아이콘이 나온다.
            let ctype = match kind {
                OsTypeKind::Folder => "inode/directory".to_string(),
                OsTypeKind::Ext | OsTypeKind::File => gio::content_type_guess(path.file_name(), &[]).0.to_string(),
            };
            let type_name = Some(gio::content_type_get_description(&ctype).to_string());
            // 테마에 없는 아이콘·불러오기 실패는 빈 자리 — 프론트가 앱 아이콘을 그린다.
            let icon_png = theme.as_ref().and_then(|t| {
                let icon = gio::content_type_get_icon(&ctype);
                let info = t.lookup_by_gicon(&icon, px as i32, gtk::IconLookupFlags::FORCE_SIZE)?;
                info.load_icon().ok()?.save_to_bufferv("png", &[]).ok()
            });
            OsTypeFound { type_name, icon_png }
        })
        .collect()
}
