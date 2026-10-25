"""Deterministic sample workspace used for a fresh local database."""

import json

from sqlalchemy.orm import Session

from auth import DEMO_PASSWORD, hash_password
from permissions import extract_variables
from models import Group, GroupMembership, Prompt, PromptVersion, User


def seed_initial_data(db: Session) -> None:
    if db.query(User).count():
        return

    # 2 Workspace Admins
    alice = User(name="Alice Morgan", email="alice@example.com", is_workspace_admin=True, password_hash=hash_password(DEMO_PASSWORD))
    evan = User(name="Evan Wright", email="evan@example.com", is_workspace_admin=True, password_hash=hash_password(DEMO_PASSWORD))

    # 2 Group Owners
    bob = User(name="Bob Chen", email="bob@example.com", password_hash=hash_password(DEMO_PASSWORD))
    diana = User(name="Diana Okafor", email="diana@example.com", password_hash=hash_password(DEMO_PASSWORD))

    # 4 Members
    charlie = User(name="Charlie Rivera", email="charlie@example.com", password_hash=hash_password(DEMO_PASSWORD))
    fiona = User(name="Fiona Gallagher", email="fiona@example.com", password_hash=hash_password(DEMO_PASSWORD))
    george = User(name="George Clark", email="george@example.com", password_hash=hash_password(DEMO_PASSWORD))
    hannah = User(name="Hannah Abbott", email="hannah@example.com", password_hash=hash_password(DEMO_PASSWORD))

    # 5 Guests
    ian = User(name="Ian Malcolm", email="ian@example.com", password_hash=hash_password(DEMO_PASSWORD))
    julia = User(name="Julia Roberts", email="julia@example.com", password_hash=hash_password(DEMO_PASSWORD))
    kevin = User(name="Kevin Bacon", email="kevin@example.com", password_hash=hash_password(DEMO_PASSWORD))
    laura = User(name="Laura Croft", email="laura@example.com", password_hash=hash_password(DEMO_PASSWORD))
    mike = User(name="Mike Ross", email="mike@example.com", password_hash=hash_password(DEMO_PASSWORD))

    marketing = Group(name="Marketing", description="Brand voice, campaigns, and customer communications", created_by=None)
    sales = Group(name="Sales", description="Sales enablement and customer conversations", created_by=None)
    legal = Group(name="Executive Legal", description="Leadership and legal review resources", created_by=None)

    db.add_all([alice, evan, bob, diana, charlie, fiona, george, hannah, ian, julia, kevin, laura, mike, marketing, sales, legal])
    db.flush()
    for group in (marketing, sales, legal):
        group.created_by = alice.id
    db.add_all([
        # Marketing: Bob (Owner), Charlie, Fiona, George (Members), Ian, Kevin (Guests)
        GroupMembership(user_id=bob.id, group_id=marketing.id, role="GROUP_MANAGER"),
        GroupMembership(user_id=charlie.id, group_id=marketing.id, role="MEMBER"),
        GroupMembership(user_id=fiona.id, group_id=marketing.id, role="MEMBER"),
        GroupMembership(user_id=george.id, group_id=marketing.id, role="MEMBER"),
        GroupMembership(user_id=ian.id, group_id=marketing.id, role="GUEST"),
        GroupMembership(user_id=kevin.id, group_id=marketing.id, role="GUEST"),

        # Sales: Diana (Owner), Bob, Fiona, Hannah (Members), Julia, Laura (Guests)
        GroupMembership(user_id=diana.id, group_id=sales.id, role="GROUP_MANAGER"),
        GroupMembership(user_id=bob.id, group_id=sales.id, role="MEMBER"),
        GroupMembership(user_id=fiona.id, group_id=sales.id, role="MEMBER"),
        GroupMembership(user_id=hannah.id, group_id=sales.id, role="MEMBER"),
        GroupMembership(user_id=julia.id, group_id=sales.id, role="GUEST"),
        GroupMembership(user_id=laura.id, group_id=sales.id, role="GUEST"),

        # Executive Legal: Mike (Guest)
        GroupMembership(user_id=mike.id, group_id=legal.id, role="GUEST"),
    ])
    samples = [
        (marketing, "Seasonal campaign writer", "Create an upbeat campaign for {{product}} aimed at {{audience}}. Use a warm, helpful tone and include one clear call to action.", "Alice Morgan", [
            "Create a campaign for {{product}} aimed at {{audience}}. Use a warm tone.",
            "Create an upbeat campaign for {{product}} aimed at {{audience}}. Use a warm, helpful tone.",
            "Create an upbeat campaign for {{product}} aimed at {{audience}}. Use a warm, helpful tone and include one clear call to action.",
        ], ["Initial campaign brief", "Added brand voice guidance", "Added a clear action for readers"]),
        (sales, "Discovery call follow-up", "Write a concise follow-up to {{contact_name}} at {{company}}. Mention {{key_need}}, suggest a next step, and keep the tone consultative.", "Diana Okafor", [
            "Write a follow-up to {{contact_name}} at {{company}}. Mention {{key_need}}.",
            "Write a concise follow-up to {{contact_name}} at {{company}}. Mention {{key_need}} and suggest a next step.",
            "Write a concise follow-up to {{contact_name}} at {{company}}. Mention {{key_need}}, suggest a next step, and keep the tone consultative.",
        ], ["Initial call follow-up", "Added next-step suggestion", "Added consultative tone"]),
    ]
    author_by_name = {u.name: u for u in (alice, bob, charlie, diana)}
    db.flush()
    for group, title, _, author_name, contents, notes in samples:
        prompt = Prompt(group_id=group.id, title=title, description=f"A reusable {group.name.lower()} prompt.", created_by=author_by_name[author_name].id)
        db.add(prompt)
        db.flush()
        prompt.current_version_number = len(contents)
        last_version_id = None
        for number, content in enumerate(contents, start=1):
            author = alice if number == 1 else author_by_name[author_name]
            pv = PromptVersion(prompt_id=prompt.id, version_number=number, content=content,
                               variables_json=json.dumps(extract_variables(content)), change_Note=notes[number - 1],
                               author_id=author.id)
            db.add(pv)
            db.flush()
            last_version_id = pv.id
        prompt.current_version_id = last_version_id
    db.commit()
