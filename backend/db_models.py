from __future__ import annotations
from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, Boolean, Integer, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column
from db import Base


class ExtensionUser(Base):
    __tablename__ = "extension_users"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # device UUID
    email: Mapped[str] = mapped_column(String, nullable=False, default="")
    subscribed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stripe_customer_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Set when a subscription is cancelled/paused; cleared when reactivated.
    # Used by purge_old_data to honour the published "30 days after cancellation" policy.
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class DailyUsage(Base):
    __tablename__ = "extension_daily_usage"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_usage_user_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("extension_users.id"), nullable=False)
    date: Mapped[str] = mapped_column(String, nullable=False)  # "YYYY-MM-DD"
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
