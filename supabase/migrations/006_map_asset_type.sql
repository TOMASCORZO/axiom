-- Add 'map' to the assets.asset_type check constraint for existing DBs.
-- 004_assets.sql already includes 'map' inline for fresh setups.

ALTER TABLE public.assets
    DROP CONSTRAINT IF EXISTS assets_asset_type_check;

ALTER TABLE public.assets
    ADD CONSTRAINT assets_asset_type_check CHECK (asset_type IN (
        'sprite','sprite_sheet','texture','texture_atlas',
        'model_3d','material','animation','audio','ui_element','font','particle','map'
    ));
