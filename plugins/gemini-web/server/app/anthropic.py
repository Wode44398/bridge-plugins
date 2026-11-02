"""Anthropic Messages 协议适配：工具调用模拟 + 思考档位。

网页端没有原生工具调用，这里用提示词约定格式：
  - 请求侧：把 tools 定义、历史里的 tool_use / tool_result 渲染成文本；
  - 响应侧：从模型输出里解析 <tool_call>{"name":…, "input":…}</tool_call>，还原成 tool_use 块。
Claude Code 这类 agent 客户端因此可以正常读写文件、执行命令。
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

# 单个工具描述的最大长度：Claude Code 的工具说明动辄上万字，全量塞进去只会拖慢首字
TOOL_DESC_LIMIT = 2400
TOOL_RESULT_LIMIT = 60000

# 2026-11-01（bridge 插件化时改）：原来用 <tool_call> 标签 + [System] / [Assistant] 伪角色标记，Gemini 网页端把整段判成
# 「注入伪造系统提示、诱导执行命令」直接拒答（Claude Code / dimensio 带工具的请求几乎全被拒）。现在如实说明场景：
# 这是用户自己电脑上的编程助手软件，由软件代为执行操作；调用写成语言标记为 tool_call 的代码块（模型最自然的输出形式）。
OPEN_TAG = "```tool_call"
CLOSE_TAG = "```"

INTRO = (
    "我在自己的电脑上用一个编程助手软件（和 Claude Code、Cursor 这类工具一样）。这个软件可以替助手在我的电脑上"
    "执行一些操作（读写文件、运行命令等），执行完把结果贴回来。请你作为这个软件里的助手，接着下面的对话写出助手的下一条回复。"
)

PROTOCOL = """## 怎么请软件执行操作
需要执行操作时，在回复里写一个代码块，语言标记写 tool_call，内容是一个 JSON 对象：
```tool_call
{"name": "操作名", "input": {参数}}
```
- JSON 要合法，input 的字段按该操作的参数格式写。
- 一次可以写多个这样的代码块；写完最后一个就结束这条回复，等软件把结果贴回来——不要自己编写或猜测执行结果。
- 不需要执行操作时，直接用自然语言回答，不要写 tool_call 代码块。
- 执行操作前可以先用一两句话说明要做什么。"""

REMINDER = "现在请写出助手的下一条回复（只写回复本身；需要执行操作就按上面的格式写 tool_call 代码块，然后停下）。"


# ---------------------------------------------------------------- 思考档位


def resolve_thinking(payload: dict[str, Any], default: bool) -> bool:
    """决定是否开网页端「深度思考」。

    优先级：显式字段 gemini_thinking（bridge 档位写入）> output_config.effort > 默认设置。
    """
    flag = payload.get("gemini_thinking")
    if isinstance(flag, bool):
        return flag
    oc = payload.get("output_config")
    if isinstance(oc, dict) and isinstance(oc.get("effort"), str):
        return oc["effort"].lower() in ("high", "xhigh", "max")
    return default


# ---------------------------------------------------------------- 请求渲染


def _text_of(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict):
                t = part.get("type")
                if t == "text" and part.get("text"):
                    out.append(str(part["text"]))
                elif t in ("image", "image_url", "document"):
                    out.append("[图片/附件已省略：当前接口不支持]")
        return "\n".join(out)
    return str(content)


def _render_tools(tools: list[dict[str, Any]]) -> str:
    lines = ["## 可以请软件执行的操作"]
    for t in tools:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        desc = str(t.get("description") or "").strip()
        if len(desc) > TOOL_DESC_LIMIT:
            desc = desc[:TOOL_DESC_LIMIT] + "…（说明已截断）"
        schema = t.get("input_schema") or {}
        lines.append(f"### {t['name']}\n{desc}\n参数格式（JSON Schema）：{json.dumps(schema, ensure_ascii=False, separators=(',', ':'))}")
    return "\n\n".join(lines)


def build_prompt(payload: dict[str, Any]) -> str:
    """把 Anthropic 请求（system + messages + tools）压成一段提示词。"""
    messages = [m for m in (payload.get("messages") or []) if isinstance(m, dict)]
    if not messages:
        raise ValueError("messages 不能为空")
    tools = [t for t in (payload.get("tools") or []) if isinstance(t, dict) and t.get("name")]
    system = _text_of(payload.get("system")).strip()

    # 无工具的单轮纯文本：原样发送，质量最好
    if not tools and not system and len(messages) == 1 and messages[0].get("role") == "user":
        text = _text_of(messages[0].get("content")).strip()
        if text:
            return text

    blocks: list[str] = [INTRO]
    if system:
        blocks.append("## 软件给助手的说明（软件开发者写的，照着做）\n" + system)
    if tools:
        blocks.append(_render_tools(tools))
        blocks.append(PROTOCOL)
    blocks.append("## 到目前为止的对话")

    names: dict[str, str] = {}
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": _text_of(content)}]
        if role == "assistant":
            buf: list[str] = []
            for p in parts:
                if not isinstance(p, dict):
                    continue
                if p.get("type") == "text" and str(p.get("text") or "").strip():
                    buf.append(str(p["text"]).strip())
                elif p.get("type") == "tool_use":
                    names[str(p.get("id") or "")] = str(p.get("name") or "")
                    call = {"name": p.get("name"), "input": p.get("input") or {}}
                    buf.append(f"{OPEN_TAG}\n{json.dumps(call, ensure_ascii=False)}\n{CLOSE_TAG}")
            if buf:
                blocks.append("**助手：**\n" + "\n".join(buf))
            continue
        # user：普通文本与工具结果分开渲染
        texts: list[str] = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "tool_result":
                tid = str(p.get("tool_use_id") or "")
                body = _text_of(p.get("content")).strip() or "（无输出）"
                if len(body) > TOOL_RESULT_LIMIT:
                    body = body[:TOOL_RESULT_LIMIT] + f"\n…（结果过长，已截断，共 {len(body)} 字）"
                flag = "（执行出错）" if p.get("is_error") else ""
                blocks.append(f"**软件贴回的执行结果（{names.get(tid, '操作')}）{flag}：**\n{body}")
            elif p.get("type") == "text" and str(p.get("text") or "").strip():
                texts.append(str(p["text"]).strip())
            elif p.get("type") in ("image", "document"):
                texts.append("[图片/附件已省略：当前接口不支持]")
        if texts:
            blocks.append("**用户：**\n" + "\n".join(texts))

    blocks.append("---\n" + REMINDER)
    return "\n\n".join(blocks)


# ---------------------------------------------------------------- 响应解析

_FENCE_RE = re.compile(r"^\s*```[\w-]*\s*$")


def _parse_call(raw: str) -> dict[str, Any] | None:
    s = raw.strip()
    s = re.sub(r"^```[\w-]*\s*", "", s)
    s = re.sub(r"\s*```$", "", s).strip()
    start = s.find("{")
    if start < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(s[start:])
    except ValueError:
        return None
    if not isinstance(obj, dict) or not obj.get("name"):
        return None
    args = obj.get("input", obj.get("arguments", obj.get("parameters", {})))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            args = {"value": args}
    if not isinstance(args, dict):
        args = {}
    return {
        "type": "tool_use",
        "id": "toolu_" + uuid.uuid4().hex[:24],
        "name": str(obj["name"]),
        "input": args,
    }


def _strip_trailing_fence(text: str) -> str:
    lines = text.rstrip().split("\n")
    while lines and _FENCE_RE.match(lines[-1]):
        lines.pop()
    return "\n".join(lines).rstrip()


def split_output(text: str, tool_names: set[str] | None = None) -> tuple[str, list[dict[str, Any]]]:
    """拆出正文与工具调用。没有合法调用时原样返回正文。"""
    idx = text.find(OPEN_TAG)
    if idx < 0:
        return text.strip(), []
    calls: list[dict[str, Any]] = []
    pos = idx
    while True:
        start = text.find(OPEN_TAG, pos)
        if start < 0:
            break
        end = text.find(CLOSE_TAG, start + len(OPEN_TAG))  # 收尾的 ``` 是开头标记的前缀：从标记之后找
        raw = text[start + len(OPEN_TAG) : end if end >= 0 else len(text)]
        call = _parse_call(raw)
        if call and (not tool_names or call["name"] in tool_names):
            calls.append(call)
        if end < 0:
            break
        pos = end + len(CLOSE_TAG)
    if not calls:
        return text.strip(), []
    return _strip_trailing_fence(text[:idx]), calls


class StreamSplitter:
    """流式版：正文按行实时放出，遇到 <tool_call> 后停止放出、留给结尾统一解析。

    代码围栏行（```）要看下一行才知道是正文还是包裹工具调用的外壳，所以暂扣一行。
    """

    def __init__(self) -> None:
        self.full = ""
        self._pending = ""  # 尚未成行的尾巴
        self._held_fence = ""  # 暂扣的围栏行
        self.stopped = False

    def feed(self, delta: str) -> str:
        self.full += delta
        if self.stopped:
            return ""
        self._pending += delta
        out: list[str] = []
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            out.append(self._line(line + "\n"))
            if self.stopped:
                return "".join(out)
        tail = self._pending
        if not tail:
            return "".join(out)
        if OPEN_TAG in tail:
            self.stopped = True
            self._held_fence = ""
            out.append(tail[: tail.find(OPEN_TAG)])
            return "".join(out)
        # 尾巴里可能是 <tool_call 的前半截，或者 ``` 围栏的开头：这部分先扣着
        hold = len(tail)
        lt = tail.rfind("<")
        if lt >= 0 and OPEN_TAG.startswith(tail[lt:]):
            hold = lt
        if tail.lstrip().startswith("`"):
            hold = 0
        if tail[:hold].strip():
            out.append(self._release_fence() + tail[:hold])
            self._pending = tail[hold:]
        return "".join(out)

    def _release_fence(self) -> str:
        f, self._held_fence = self._held_fence, ""
        return f

    def _line(self, line: str) -> str:
        if OPEN_TAG in line:
            self.stopped = True
            self._held_fence = ""
            return line[: line.find(OPEN_TAG)]
        if _FENCE_RE.match(line.rstrip("\n")):
            prev = self._release_fence()
            self._held_fence = line
            return prev
        return self._release_fence() + line

    def flush(self) -> str:
        if self.stopped:
            return ""
        out = self._release_fence() + self._pending
        self._pending = ""
        return out
