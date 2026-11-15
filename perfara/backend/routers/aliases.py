"""项目别名路由（展示名映射）。"""
from fastapi import APIRouter
from ._common import (
    HTTPException, Depends, func, List, Session,
    get_db, ProjectAlias, ProjectAliasIn, ProjectAliasOut,
    require_uid, is_super_uid, is_demo_perfara_uid,
    _norm_alias_field, _column_eq_optional,
)

router = APIRouter()


@router.get(
    "/api/project-aliases",
    response_model=List[ProjectAliasOut],
)
def list_aliases(
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    q = db.query(ProjectAlias)
    if not is_super_uid(uid):
        q = q.filter(func.lower(ProjectAlias.owner_uid) == (uid or "").strip().lower())
    aliases = q.order_by(ProjectAlias.id.asc()).all()
    return [ProjectAliasOut.from_model(a) for a in aliases]


@router.put(
    "/api/project-aliases",
    response_model=List[ProjectAliasOut],
)
def upsert_aliases(
    items: List[ProjectAliasIn],
    db: Session = Depends(get_db),
    uid: str = Depends(require_uid),
):
    if is_demo_perfara_uid(uid):
        raise HTTPException(status_code=403, detail="演示账号不可修改别名")
    uname = (uid or "").strip()
    updated: List[ProjectAliasOut] = []
    for item in items:
        pkg = _norm_alias_field(item.package_name)
        appn = _norm_alias_field(item.app_name)
        disp = (item.display_name or "").strip()
        q = db.query(ProjectAlias).filter(
            _column_eq_optional(ProjectAlias.package_name, pkg),
            _column_eq_optional(ProjectAlias.app_name, appn),
        )
        if not is_super_uid(uid):
            q = q.filter(func.lower(ProjectAlias.owner_uid) == uname.lower())
        alias = q.first()
        if alias:
            alias.display_name = disp if disp else None
        else:
            alias = ProjectAlias(
                package_name=pkg,
                app_name=appn,
                display_name=disp if disp else None,
                owner_uid=uname,
            )
            db.add(alias)
            db.flush()
        updated.append(ProjectAliasOut.from_model(alias))
    db.commit()
    return updated
