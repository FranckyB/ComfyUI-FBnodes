"""
Node replacement registrations for backward compatibility.
Maps deprecated node IDs to their current replacements so existing workflows
can be automatically migrated.
"""
from comfy_api.latest import ComfyExtension, io, ComfyAPI

api = ComfyAPI()


async def register_replacements():
    # SaveVideoH26x -> SaveVideoPlus (simple rename, same inputs/outputs)
    await api.node_replacement.register(io.NodeReplace(
        new_node_id="SaveVideoPlus",
        old_node_id="SaveVideoH26x",
    ))

    # PromptApplyLora -> ApplyLoraPlus (simple rename, same inputs/outputs)
    await api.node_replacement.register(io.NodeReplace(
        new_node_id="ApplyLoraPlus",
        old_node_id="PromptApplyLora",
    ))

    # BetterImageLoader -> LoadImagePlus (simple rename, same inputs/outputs)
    await api.node_replacement.register(io.NodeReplace(
        new_node_id="LoadImagePlus",
        old_node_id="BetterImageLoader",
    ))


class FBnodesReplacements(ComfyExtension):
    async def on_load(self) -> None:
        await register_replacements()

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return []


async def comfy_entrypoint() -> FBnodesReplacements:
    return FBnodesReplacements()
