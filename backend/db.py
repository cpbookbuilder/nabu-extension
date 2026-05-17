import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

# Railway provides postgresql://, asyncpg needs postgresql+asyncpg://
_url = os.environ["DATABASE_URL"].replace("postgresql://", "postgresql+asyncpg://", 1)

engine = create_async_engine(_url, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def create_tables():
    import db_models  # noqa: F401 — registers models with Base
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Idempotent backfill for the (user_id, date) uniqueness constraint added
        # after the table already shipped without it.
        await conn.execute(text("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'uq_daily_usage_user_date'
                ) THEN
                    -- Collapse any pre-existing duplicates first so the constraint can attach.
                    DELETE FROM extension_daily_usage a
                    USING extension_daily_usage b
                    WHERE a.id < b.id
                      AND a.user_id = b.user_id
                      AND a.date = b.date;
                    ALTER TABLE extension_daily_usage
                        ADD CONSTRAINT uq_daily_usage_user_date UNIQUE (user_id, date);
                END IF;
            END $$;
        """))
        # Idempotent backfill for cancelled_at column on tables that pre-date it.
        await conn.execute(text(
            "ALTER TABLE extension_users "
            "ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE"
        ))
