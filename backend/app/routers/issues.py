from fastapi import APIRouter, HTTPException
from sqlmodel import col, select

from ..db import SessionDep
from ..llm import ask_llm
from ..models import CATEGORIES, Issue, IssueCreate, IssueUpdate

router = APIRouter(prefix="/api/issues", tags=["Обращения"])


def get_or_404(session: SessionDep, issue_id: int) -> Issue:
    issue = session.get(Issue, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Обращение не найдено")
    return issue


@router.get("/categories")
def list_categories() -> list[str]:
    return CATEGORIES


@router.get("")
def list_issues(session: SessionDep) -> list[Issue]:
    return list(session.exec(select(Issue).order_by(col(Issue.created_at).desc())).all())


@router.post("", status_code=201)
def create_issue(data: IssueCreate, session: SessionDep) -> Issue:
    issue = Issue.model_validate(data)
    session.add(issue)
    session.commit()
    session.refresh(issue)
    return issue


@router.patch("/{issue_id}")
def update_issue(issue_id: int, data: IssueUpdate, session: SessionDep) -> Issue:
    issue = get_or_404(session, issue_id)
    issue.sqlmodel_update(data.model_dump(exclude_unset=True))
    session.add(issue)
    session.commit()
    session.refresh(issue)
    return issue


@router.delete("/{issue_id}", status_code=204)
def delete_issue(issue_id: int, session: SessionDep) -> None:
    session.delete(get_or_404(session, issue_id))
    session.commit()


@router.post("/{issue_id}/ai")
def ai_comment(issue_id: int, session: SessionDep) -> Issue:
    """Просит нейросеть предложить, кому передать обращение и что сделать."""
    issue = get_or_404(session, issue_id)
    issue.ai_comment = ask_llm(
        system=(
            "Ты помощник администрации города Обнинска. Отвечай по-русски, "
            "кратко, 2–3 предложения, без вступлений."
        ),
        prompt=(
            f"Обращение жителя.\nКатегория: {issue.category}\n"
            f"Заголовок: {issue.title}\nТекст: {issue.description}\n\n"
            "Какая служба должна этим заняться и какой первый шаг?"
        ),
    )
    session.add(issue)
    session.commit()
    session.refresh(issue)
    return issue
