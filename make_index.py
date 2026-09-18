#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_index.py
伊纳特语词典项目 —— 索引生成脚本

职责（严格对应方案第三节）：
  1. JSON 语法 / 结构校验：遍历 data/ 下全部源 JSON 文件；
     只要有一个文件不合法 —— 立即终止，不覆盖旧的 index.json。
  2. 动词自动变位引擎：读取 root / conj_pattern，生成完整 conjugation。
  3. 词条集合合并：名词 + 形容词 + 变位后的动词。
  4. 输出 data/index.json；脚本永远不会改写任何源文件。

用法：
  python make_index.py           # 正常执行
  python make_index.py --check   # 只校验，不写文件（本地自查 / CI 预检）
"""

from __future__ import annotations

import copy
import datetime
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

# --------------------------------------------------------------------------
# 路径配置
# --------------------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
INDEX_PATH = DATA_DIR / "index.json"

VALID_POS = {"n", "v", "adj"}
VALID_GENDER = {"common", "neutral"}

# --------------------------------------------------------------------------
# 伊纳特语字母表与排序规则（按用户提供的真实字母顺序，不是拉丁字母顺序！）
# 如果以后字母表里出现像 "th" 这样占多个字符的复合字母，下面的分词逻辑
# 会自动优先整体匹配，不用另外改代码——只需要把它整体作为一个字符串加进
# CUSTOM_ALPHABET 列表即可。
# --------------------------------------------------------------------------

CUSTOM_ALPHABET = [
    "a", "ă", "b", "c", "ç", "d", "e", "f", "g", "h", "i", "ŭ", "j", "k", "l",
    "m", "n", "ń", "o", "p", "ž", "r", "s", "t", "x", "u", "v", "w", "z", "ź", 
]
LETTER_RANK = {letter: idx for idx, letter in enumerate(CUSTOM_ALPHABET)}
# 多字符字母（如果以后字母表里又加入类似 "th" 的复合字母）按长度从长到短
# 排列，分词时优先匹配；目前这套字母表里没有复合字母，这里会是空列表。
MULTI_CHAR_LETTERS = sorted(
    (l for l in CUSTOM_ALPHABET if len(l) > 1), key=len, reverse=True
)


def tokenize_word(word: str) -> List[str]:
    """把一个词切分成“字母单位”序列，正确识别 th 这样的复合字母。"""
    w = word.lower()
    tokens: List[str] = []
    i = 0
    n = len(w)
    while i < n:
        matched = None
        for ml in MULTI_CHAR_LETTERS:
            if w.startswith(ml, i):
                matched = ml
                break
        if matched is None:
            matched = w[i]
        tokens.append(matched)
        i += len(matched)
    return tokens


def collation_key(word: str):
    """按伊纳特语真实字母顺序生成排序键；表外字符（如遗留占位数据里的普通
    拉丁字母）不会报错，只是被排到已知字母表之后，按 Unicode 码位排序。"""
    tokens = tokenize_word(word)
    return tuple(LETTER_RANK.get(t, 10_000 + ord(t[0])) for t in tokens)


def display_letter(word: str) -> str:
    """词条的“首字母”显示形式，供网页字母导航分组使用，例如 th 开头显示为 Th。"""
    tokens = tokenize_word(word)
    return tokens[0].capitalize() if tokens else ""

# 源文件里必须原样保留的“空值”字段（不可省略，见方案“字段约束规则”）
COMMON_REQUIRED_KEYS = [
    "id", "word", "pos", "translations", "etymology",
    "examples", "synonyms", "antonyms", "tags",
]


# --------------------------------------------------------------------------
# 异常类型：任何一种都意味着“校验失败，终止并保留旧索引”
# --------------------------------------------------------------------------

class ValidationError(Exception):
    """单个源文件里的语法或结构错误。"""

    def __init__(self, file: Path, message: str):
        self.file = file
        self.message = message
        super().__init__(f"[{file.name}] {message}")


# --------------------------------------------------------------------------
# 第一步：JSON 语法 + 基础结构校验
# --------------------------------------------------------------------------

def load_source_files() -> List[Path]:
    """列出 data/ 下所有源 JSON 文件（排除脚本生成的 index.json）。"""
    if not DATA_DIR.is_dir():
        raise ValidationError(DATA_DIR, "data/ 目录不存在")
    files = sorted(
        p for p in DATA_DIR.glob("*.json")
        if p.name != "index.json"
    )
    return files


def validate_entry(entry: Dict[str, Any], file: Path, idx: int) -> None:
    """校验单条词条的字段结构（语法之外的“形状”校验）。"""
    where = f"第 {idx + 1} 条词条"

    for key in COMMON_REQUIRED_KEYS:
        if key not in entry:
            raise ValidationError(file, f"{where} 缺少必填字段 “{key}”")

    if not isinstance(entry["id"], str) or not entry["id"]:
        raise ValidationError(file, f"{where} 的 id 必须是非空字符串")

    if not isinstance(entry["word"], str) or not entry["word"]:
        raise ValidationError(file, f"{where} 的 word 必须是非空字符串")

    pos = entry.get("pos")
    if pos not in VALID_POS:
        raise ValidationError(
            file, f"{where}（{entry.get('word')}）pos 必须是 n|v|adj，实际为 {pos!r}"
        )

    translations = entry["translations"]
    if not isinstance(translations, dict):
        raise ValidationError(file, f"{where} 的 translations 必须是对象")
    for lang in ("zh", "en", "es"):
        if lang not in translations:
            raise ValidationError(file, f"{where} 的 translations 缺少 “{lang}”")

    if not isinstance(entry["etymology"], list):
        raise ValidationError(file, f"{where} 的 etymology 必须是数组（可为空 []）")
    if not isinstance(entry["examples"], list):
        raise ValidationError(file, f"{where} 的 examples 必须是数组（可为空 []）")
    if not isinstance(entry["synonyms"], list):
        raise ValidationError(file, f"{where} 的 synonyms 必须是数组（可为空 []）")
    if not isinstance(entry["antonyms"], list):
        raise ValidationError(file, f"{where} 的 antonyms 必须是数组（可为空 []）")
    if not isinstance(entry["tags"], list):
        raise ValidationError(file, f"{where} 的 tags 必须是数组（可为空 []）")

    if pos in ("n", "adj"):
        if "gender" not in entry or entry["gender"] not in VALID_GENDER:
            raise ValidationError(
                file, f"{where}（{entry.get('word')}）gender 必须是 common|neutral"
            )
        if "declension" not in entry or not isinstance(entry["declension"], dict):
            raise ValidationError(file, f"{where} 缺少 declension 对象")
        if "conjugation" not in entry or not isinstance(entry["conjugation"], dict):
            raise ValidationError(file, f"{where} 缺少 conjugation 字段（应为空对象 {{}}）")

    if pos == "v":
        if "root" not in entry or not isinstance(entry["root"], str) or not entry["root"]:
            raise ValidationError(file, f"{where}（{entry.get('word')}）缺少非空 root")
        if "conj_pattern" not in entry or not entry["conj_pattern"]:
            raise ValidationError(file, f"{where}（{entry.get('word')}）缺少 conj_pattern")
        if "conjugation" not in entry or entry["conjugation"] != {}:
            raise ValidationError(
                file,
                f"{where}（{entry.get('word')}）动词源文件的 conjugation 必须保持空对象 {{}}，"
                f"完整变位由脚本计算生成",
            )


def load_and_validate_all() -> List[Dict[str, Any]]:
    """读取全部源文件，逐条校验；任何问题都直接抛出，交由 main() 统一处理。"""
    files = load_source_files()
    if not files:
        raise ValidationError(DATA_DIR, "data/ 目录下没有找到任何源 JSON 文件")

    all_entries: List[Dict[str, Any]] = []
    seen_ids: Dict[str, Path] = {}

    for file in files:
        raw = file.read_text(encoding="utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValidationError(
                file, f"JSON 语法错误：第 {exc.lineno} 行第 {exc.colno} 列 —— {exc.msg}"
            ) from exc

        if not isinstance(payload, list):
            raise ValidationError(file, "源文件顶层必须是词条数组 []")

        for idx, entry in enumerate(payload):
            if not isinstance(entry, dict):
                raise ValidationError(file, f"第 {idx + 1} 条词条必须是 JSON 对象")
            validate_entry(entry, file, idx)

            entry_id = entry["id"]
            if entry_id in seen_ids:
                raise ValidationError(
                    file,
                    f"id “{entry_id}” 与 {seen_ids[entry_id].name} 中的词条重复",
                )
            seen_ids[entry_id] = file

            enriched = copy.deepcopy(entry)
            enriched["_source_file"] = file.name
            all_entries.append(enriched)

    return all_entries


# --------------------------------------------------------------------------
# 第二步：动词自动变位引擎
# --------------------------------------------------------------------------
#
# 规则动词：按 conj_pattern 查“规则表”，用 root + 词缀拼接。
# 不规则动词：conj_pattern == "irregular"，按 root 或 id 直接查 IRREGULAR_VERBS。
#
# 这里内置的规则表是一套“默认占位规则”，请按照伊纳特语实际语法在下方两张表中调整——
# 结构（直陈式 / 虚拟式 / 命令式 / 非限定式）不需要改，改的是后缀本身。

PERSONS = ["1sg", "2sg", "3sg", "1pl", "2pl", "3pl"]

# 规则变位模式表：conj_pattern -> {时态: {人称: 后缀}}
REGULAR_PATTERNS: Dict[str, Dict[str, Dict[str, str]]] = {
    "I": {  # 第一变位式，例如以 -a 结尾的词根
        "直陈式现在时": {
            "1sg": "a", "2sg": "as", "3sg": "at",
            "1pl": "amus", "2pl": "atis", "3pl": "ant",
        },
        "直陈式过去时": {
            "1sg": "aba", "2sg": "abas", "3sg": "abat",
            "1pl": "abamus", "2pl": "abatis", "3pl": "aband",
        },
        "直陈式将来时": {
            "1sg": "abo", "2sg": "abis", "3sg": "abit",
            "1pl": "abimus", "2pl": "abitis", "3pl": "abunt",
        },
        "虚拟式": {
            "1sg": "em", "2sg": "es", "3sg": "et",
            "1pl": "emus", "2pl": "etis", "3pl": "ent",
        },
        "命令式": {"2sg": "a", "2pl": "ate"},
        "非限定式": {"不定式": "are", "动名词": "ando", "过去分词": "atum"},
    },
    "II": {  # 第二变位式，例如以 -e 结尾的词根
        "直陈式现在时": {
            "1sg": "eo", "2sg": "es", "3sg": "et",
            "1pl": "emus", "2pl": "etis", "3pl": "ent",
        },
        "直陈式过去时": {
            "1sg": "eba", "2sg": "ebas", "3sg": "ebat",
            "1pl": "ebamus", "2pl": "ebatis", "3pl": "ebant",
        },
        "直陈式将来时": {
            "1sg": "ebo", "2sg": "ebis", "3sg": "ebit",
            "1pl": "ebimus", "2pl": "ebitis", "3pl": "ebunt",
        },
        "虚拟式": {
            "1sg": "eam", "2sg": "eas", "3sg": "eat",
            "1pl": "eamus", "2pl": "eatis", "3pl": "eant",
        },
        "命令式": {"2sg": "e", "2pl": "ete"},
        "非限定式": {"不定式": "ere", "动名词": "endo", "过去分词": "itum"},
    },
    "III": {  # 第三变位式，例如以辅音结尾的词根
        "直陈式现在时": {
            "1sg": "o", "2sg": "is", "3sg": "it",
            "1pl": "imus", "2pl": "itis", "3pl": "unt",
        },
        "直陈式过去时": {
            "1sg": "eba", "2sg": "ebas", "3sg": "ebat",
            "1pl": "ebamus", "2pl": "ebatis", "3pl": "ebant",
        },
        "直陈式将来时": {
            "1sg": "am", "2sg": "es", "3sg": "et",
            "1pl": "emus", "2pl": "etis", "3pl": "ent",
        },
        "虚拟式": {
            "1sg": "am", "2sg": "as", "3sg": "at",
            "1pl": "amus", "2pl": "atis", "3pl": "ant",
        },
        "命令式": {"2sg": "e", "2pl": "ite"},
        "非限定式": {"不定式": "ere", "动名词": "endo", "过去分词": "tum"},
    },
}

# 不规则动词表：key 为 root（也可以按需换成用 id 作为 key），value 是完整 conjugation。
# 这里只放一个示例，实际词条按需要在此补充。
IRREGULAR_VERBS: Dict[str, Dict[str, Any]] = {
    "es": {  # 示例：类似“是/to be”这种高频不规则动词
        "直陈式现在时": {
            "1sg": "sum", "2sg": "es", "3sg": "est",
            "1pl": "sumus", "2pl": "estis", "3pl": "sunt",
        },
        "直陈式过去时": {
            "1sg": "eram", "2sg": "eras", "3sg": "erat",
            "1pl": "eramus", "2pl": "eratis", "3pl": "erant",
        },
        "直陈式将来时": {
            "1sg": "ero", "2sg": "eris", "3sg": "erit",
            "1pl": "erimus", "2pl": "eritis", "3pl": "erunt",
        },
        "虚拟式": {
            "1sg": "sim", "2sg": "sis", "3sg": "sit",
            "1pl": "simus", "2pl": "sitis", "3pl": "sint",
        },
        "命令式": {"2sg": "es", "2pl": "este"},
        "非限定式": {"不定式": "esse", "动名词": "—", "过去分词": "futurum"},
    },
}


class ConjugationError(Exception):
    pass


def conjugate_verb(entry: Dict[str, Any]) -> Dict[str, Any]:
    """根据 root + conj_pattern 计算完整 conjugation 对象。"""
    root = entry["root"]
    pattern = entry["conj_pattern"]
    word = entry.get("word")

    if pattern == "irregular":
        table = IRREGULAR_VERBS.get(root)
        if table is None:
            raise ConjugationError(
                f"动词 “{word}”（root={root!r}）标记为 irregular，"
                f"但 IRREGULAR_VERBS 中找不到对应词根，请在 make_index.py 中补充"
            )
        return copy.deepcopy(table)

    rules = REGULAR_PATTERNS.get(pattern)
    if rules is None:
        raise ConjugationError(
            f"动词 “{word}” 的 conj_pattern “{pattern}” 未知，"
            f"可用值：{sorted(REGULAR_PATTERNS)} 或 irregular"
        )

    conjugation: Dict[str, Any] = {}
    for tense, forms in rules.items():
        conjugation[tense] = {
            person: f"{root}{suffix}" for person, suffix in forms.items()
        }
    return conjugation


# --------------------------------------------------------------------------
# 第三步：合并词条集合 + 输出索引
# --------------------------------------------------------------------------

def build_index(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    merged: List[Dict[str, Any]] = []

    for entry in entries:
        out = copy.deepcopy(entry)
        out.pop("_source_file", None)
        if out["pos"] == "v":
            out["conjugation"] = conjugate_verb(out)
        # “letter” 是给网页字母导航用的派生字段，按伊纳特语真实字母表计算，
        # 源 JSON 文件里不需要、也不应该手动填写这个字段。
        out["letter"] = display_letter(out["word"])
        merged.append(out)

    merged.sort(key=lambda e: collation_key(e["word"]))

    return {
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds"),
        "count": len(merged),
        "entries": merged,
    }


def write_index(index_data: Dict[str, Any]) -> None:
    tmp_path = INDEX_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(
        json.dumps(index_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(INDEX_PATH)  # 原子替换，避免半写文件


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------

def main() -> int:
    check_only = "--check" in sys.argv[1:]

    try:
        entries = load_and_validate_all()
        index_data = build_index(entries)
    except (ValidationError, ConjugationError) as exc:
        print("❌ 校验失败，index.json 未被修改，旧索引继续保留。", file=sys.stderr)
        print(f"   原因：{exc}", file=sys.stderr)
        return 1

    if check_only:
        print(f"✅ 校验通过：{index_data['count']} 条词条，未写入文件（--check 模式）。")
        return 0

    write_index(index_data)
    print(f"✅ 已生成 {INDEX_PATH.relative_to(ROOT_DIR)}，共 {index_data['count']} 条词条。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
