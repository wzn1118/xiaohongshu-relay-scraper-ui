from __future__ import annotations

import re
from typing import Any


_ROLE_SIGNAL = re.compile(
    r"(?:实习|intern(?:ship)?|运营|产品|分析|研究|咨询|策划|编辑|剪辑|设计|"
    r"工程师|开发|测试|算法|数据|销售|市场|品牌|商务|财务|法务|人力|招聘|"
    r"行政|助理|顾问|经理|专员|管培生|研究员)",
    re.I,
)
_ROLE_CORE_SIGNAL = re.compile(
    r"(?:\u4ea7\u54c1|\u8fd0\u8425|\u7528\u6237\u7814\u7a76|\u6570\u636e|\u5206\u6790|\u5546\u4e1a|\u5e02\u573a|\u54c1\u724c|\u5546\u52a1|\u9500\u552e|\u8d22\u52a1|\u6cd5\u52a1|\u4eba\u529b|\u884c\u653f|\u52a9\u7406|\u9879\u76ee|\u7ecf\u7406|\u4e13\u5458|\u5de5\u7a0b\u5e08|\u7b97\u6cd5|\u8bbe\u8ba1|\u5f00\u53d1|\u7814\u53d1|\u7f16\u8f91|\u54a8\u8be2|\u533b\u5b66|\u533b\u836f|\u4fe1\u606f|\u6c9f\u901a|product|operations?|marketing|design|engineer|developer|analyst|research|sales|finance|legal|human\s+resources?|consult)",
    re.I,
)
_ROLE_SHAPE_SIGNAL = re.compile(
    r"(?:实习生|实习岗|实习|intern(?:ship)?|trainee|经理|专员|助理|工程师|开发|研发|"
    r"测试|算法|设计|编辑|剪辑|分析师|研究员|顾问|管培生|运营|产品|研究|分析|咨询|"
    r"策划|市场|品牌|商务|销售|财务|法务|人力|行政|沟通员|信息员|manager|specialist|assistant|"
    r"engineer|developer|analyst|researcher|designer|operator|operations?|marketing)$",
    re.I,
)
_ROLE_DISQUALIFIER = re.compile(
    r"(?:继任|急{1,}|急招|急聘|招聘|招募|内推|直招|速来|投递|到岗|入职|优先|"
    r"有[^\n]{0,12}实习|能来实习|实习的?吗|找[^\n]{0,12}实习|岗位职责|工作职责|"
    r"职位描述|任职要求|岗位要求|薪资|待遇|工作地点|办公地点|负责|协助|参与|"
    r"请将|简历|邮箱|联系方式|为什么|怎么|如何|面试|面经|总结|复盘|而不是|#|[?？！!。；;])",
    re.I,
)
_APPLICATION_PREFIX = re.compile(r"^\s*(?:主题\s*[:：]\s*)?(?:应聘|申请|求职)(?:岗位|职位)?\s*[:：]?\s*", re.I)
_SOCIAL_SUCCESSOR_PREFIX = re.compile(
    r"^\s*(?:(?:给|替|帮)自己)?(?:找|招)(?:个)?(?:实习)?继任(?:者)?\s*(?:[-—:：|｜]+\s*)?",
    re.I,
)
_RECRUITMENT_PREFIX = re.compile(
    r"^\s*(?:[#＃]*\s*)?(?:【|\[)?\s*(?:急招|招聘|招募|内推|直招|招(?:实习)?继任)(?:中|岗位|职位|信息)?\s*(?:】|\])?\s*(?:[-—:：|｜]+\s*)?",
    re.I,
)
_TRAILING_RECRUITMENT_NOISE = re.compile(
    r"(?:\s*(?:[-—:：|｜]+\s*)?(?:急招|招聘|招募|招)(?:实习)?继任(?:者)?|"
    r"\s*(?:[-—:：|｜]+\s*)?(?:招聘|招募|热招|开放)(?:中|进行中)?|"
    r"\s*(?:[-—:：|｜]+\s*)?(?:招聘|招募)\s*\d+\s*(?:人|位|名))\s*$",
    re.I,
)
_RECRUITMENT_NOISE = re.compile(
    r"(?:应聘|申请|求职|急招|招聘|招募|内推|直招|找(?:个)?(?:实习)?继任|招(?:实习)?继任)",
    re.I,
)
_HARD_RECRUITMENT_SLOGAN = re.compile(
    r"(?:\u6025{2,}|\u6709\s*\d{1,2}\s*\u6708[^\n]{0,18}(?:\u5b9e\u4e60|\u5230\u5c97)|\u80fd\u6765\u5b9e\u4e60|\u5b9e\u4e60\u7684?\u5417|\u8058\u7ee7\u4efb)",
    re.I,
)
_CANDIDATE_NAME = re.compile(
    r"^[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
    r"戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐"
    r"费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平"
    r"黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝"
    r"董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊"
    r"胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石"
    r"崔吉龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫"
    r"乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符"
    r"刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸籍赖卓蔺屠蒙池乔"
    r"阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边"
    r"扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终"
    r"暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖"
    r"融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益"
    r"桓公][\u4e00-\u9fff]{1,2}$"
)
_LEADING_CITY = re.compile(
    r"^(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|天津|重庆|西安|长沙|"
    r"郑州|合肥|厦门|青岛|宁波|无锡|东莞|佛山)(?:市)?(?="
    r"(?:AI|数据|内容|用户|产品|品牌|市场|商业|业务|增长|社群|电商|海外|新媒体|"
    r"短视频|直播|视觉|平面|剪辑|人力|招聘|行政|财务|法务|销售|商务|研发|软件|"
    r"算法|测试|咨询|研究|项目|运营|分析|设计|开发|工程))",
    re.I,
)


def _clean_piece(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip(" \t\r\n#＃【】[]|｜:：-—，,。；;")


def normalize_role_title(value: Any) -> str:
    """Extract a sendable role name while retaining the original title elsewhere."""
    if not isinstance(value, str):
        return ""
    original = re.sub(r"\s+", " ", value).strip()
    if not original:
        return ""

    had_application_prefix = bool(_APPLICATION_PREFIX.match(original))
    hard_recruitment_slogan = bool(_HARD_RECRUITMENT_SLOGAN.search(original))
    had_recruitment_noise = bool(_RECRUITMENT_NOISE.search(original)) or hard_recruitment_slogan
    if hard_recruitment_slogan and not _ROLE_CORE_SIGNAL.search(original):
        return ""
    title = _APPLICATION_PREFIX.sub("", original, count=1)
    title = _SOCIAL_SUCCESSOR_PREFIX.sub("", title, count=1)
    title = _RECRUITMENT_PREFIX.sub("", title, count=1)
    title = re.sub(r"(?:找|招|蹲|换|聘)(?:个|一个)?(?:实习)?继任(?:者)?(?:急+)?", " ", title, flags=re.I)
    title = re.sub(r"\bASAP\b|速来投递|接受无经验|到岗优先|尽快到岗|暑假到岗", " ", title, flags=re.I)
    title = re.split(r"[?？！!]", title, maxsplit=1)[0].strip()

    pieces = [_clean_piece(piece) for piece in re.split(r"\s*[|｜]\s*", title)]
    pieces = [piece for piece in pieces if piece]
    if len(pieces) > 1:
        while len(pieces) > 1:
            suffix = pieces[-1]
            metadata = bool(
                re.search(r"^(?:每周|到岗|姓名|候选人|应聘者|作者|发布者)", suffix, re.I)
                or re.fullmatch(r"(?:组|团队|招聘组)", suffix, re.I)
                or _CANDIDATE_NAME.fullmatch(suffix)
                or (had_application_prefix and not _ROLE_SIGNAL.search(suffix))
            )
            if not metadata:
                break
            pieces.pop()
        if (
            len(pieces) > 1
            and had_recruitment_noise
            and all(_ROLE_SIGNAL.search(piece) for piece in pieces)
        ):
            title = "/".join(pieces)
        else:
            title = "｜".join(pieces)
    elif pieces:
        title = pieces[0]
    else:
        title = ""

    previous = None
    while title and title != previous:
        previous = title
        title = _TRAILING_RECRUITMENT_NOISE.sub("", title).strip()

    if had_recruitment_noise:
        title = _LEADING_CITY.sub("", title, count=1)

    title = re.sub(r"\s*/\s*", "/", title)
    title = _clean_piece(title)
    if not title or len(title) > 60 or _ROLE_DISQUALIFIER.search(title):
        return ""
    if re.fullmatch(r"(?:岗位|职位|实习|实习生|intern(?:ship)?|招聘信息)", title, re.I):
        return ""
    shape_title = re.sub(r"[（(][^）)]{1,30}[）)]$", "", title).strip()
    shape_segments = [segment.strip() for segment in re.split(r"[/|｜]", shape_title) if segment.strip()]
    if not _ROLE_CORE_SIGNAL.search(shape_title) or not any(
        _ROLE_SHAPE_SIGNAL.search(segment) for segment in shape_segments
    ):
        return ""
    return title
