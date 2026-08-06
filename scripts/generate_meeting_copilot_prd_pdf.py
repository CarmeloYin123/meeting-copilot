#!/usr/bin/env python3
"""Generate the Meeting Copilot V1.0 PRD PDF with vector diagrams and wireframes."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "Meeting_Copilot_V1_PRD_v1.0_2026-08-06.pdf"

PAGE_W, PAGE_H = A4
MARGIN = 17 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

NAVY = HexColor("#10233F")
BLUE = HexColor("#2563EB")
CYAN = HexColor("#0EA5E9")
MINT = HexColor("#10B981")
TEAL = HexColor("#14B8A6")
INDIGO = HexColor("#4F46E5")
INK = HexColor("#1E293B")
MUTED = HexColor("#64748B")
LINE = HexColor("#D7E0EC")
BG = HexColor("#F7FAFE")
LIGHT_BLUE = HexColor("#EAF3FF")
LIGHT_MINT = HexColor("#E9FBF4")
LIGHT_ORANGE = HexColor("#FFF6E6")
LIGHT_RED = HexColor("#FFF1F2")

FONT_NAME = "ArialUnicode"
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
pdfmetrics.registerFont(TTFont(FONT_NAME, FONT_PATH))


def p(text, style):
    return Paragraph(text, style)


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="TitleCN", parent=styles["Title"], fontName=FONT_NAME, fontSize=27,
    leading=36, textColor=NAVY, alignment=TA_LEFT, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="H1CN", parent=styles["Heading1"], fontName=FONT_NAME, fontSize=18,
    leading=25, textColor=NAVY, spaceBefore=4, spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="H2CN", parent=styles["Heading2"], fontName=FONT_NAME, fontSize=13.5,
    leading=20, textColor=BLUE, spaceBefore=7, spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="BodyCN", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=9.1,
    leading=14, textColor=INK, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="SmallCN", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=7.7,
    leading=11, textColor=MUTED,
))
styles.add(ParagraphStyle(
    name="CardTitle", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=10.8,
    leading=14, textColor=NAVY,
))
styles.add(ParagraphStyle(
    name="CardText", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=8.1,
    leading=11, textColor=INK,
))
styles.add(ParagraphStyle(
    name="WhiteTitle", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=16,
    leading=22, textColor=colors.white,
))
styles.add(ParagraphStyle(
    name="WhiteText", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=8.7,
    leading=13, textColor=HexColor("#DCEAFF"),
))


def bullet(text):
    return p(f"<font color='#2563EB'>—</font>　{text}", styles["BodyCN"])


def label(text, color=BLUE):
    return Table([[p(text, ParagraphStyle(
        "label", parent=styles["SmallCN"], textColor=color, fontSize=8.2, leading=10,
    ))]], colWidths=[None], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_BLUE),
        ("BOX", (0, 0), (-1, -1), 0.5, HexColor("#BFD7FF")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))


def arrow(c, x1, y1, x2, y2, color=BLUE):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.3)
    c.line(x1, y1, x2, y2)
    # Draw a small arrowhead pointing toward (x2, y2), kept simple for horizontal/vertical links.
    if abs(x2 - x1) >= abs(y2 - y1):
        dx = 1 if x2 > x1 else -1
        c.line(x2, y2, x2 - 5 * dx, y2 + 3)
        c.line(x2, y2, x2 - 5 * dx, y2 - 3)
    else:
        dy = 1 if y2 > y1 else -1
        c.line(x2, y2, x2 - 3, y2 - 5 * dy)
        c.line(x2, y2, x2 + 3, y2 - 5 * dy)


def canvas_text(c, text, x, y, width, font_size=8, color=INK, leading=None, align="left"):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    leading = leading or font_size * 1.35
    c.setFont(FONT_NAME, font_size)
    c.setFillColor(color)
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        line = ""
        for char in paragraph:
            candidate = line + char
            if stringWidth(candidate, FONT_NAME, font_size) > width and line:
                lines.append(line)
                line = char
            else:
                line = candidate
        if line:
            lines.append(line)
    for index, line in enumerate(lines):
        tx = x
        if align == "center":
            tx = x + (width - stringWidth(line, FONT_NAME, font_size)) / 2
        c.drawString(tx, y - index * leading, line)
    return len(lines) * leading


class Diagram(Flowable):
    def __init__(self, kind, width=CONTENT_W, height=250):
        super().__init__()
        self.kind = kind
        self.width = width
        self.height = height

    def draw_box(self, c, x, y, w, h, title, detail="", fill=colors.white, stroke=LINE, accent=BLUE):
        c.setFillColor(fill)
        c.setStrokeColor(stroke)
        c.setLineWidth(0.8)
        c.roundRect(x, y, w, h, 7, fill=1, stroke=1)
        c.setFillColor(accent)
        c.roundRect(x, y + h - 5, w, 5, 6, fill=1, stroke=0)
        canvas_text(c, title, x + 9, y + h - 20, w - 18, 10, NAVY)
        if detail:
            canvas_text(c, detail, x + 9, y + h - 37, w - 18, 7.2, MUTED, 9.8)

    def draw(self):
        c = self.canv
        w, h = self.width, self.height
        c.setFillColor(BG)
        c.roundRect(0, 0, w, h, 10, fill=1, stroke=0)
        if self.kind == "business":
            self._business(c, w, h)
        elif self.kind == "technical":
            self._technical(c, w, h)
        elif self.kind == "workflow":
            self._workflow(c, w, h)
        elif self.kind == "prototype":
            self._prototype(c, w, h)
        elif self.kind == "review":
            self._review(c, w, h)

    def _business(self, c, w, h):
        canvas_text(c, "Meeting Copilot 的会前—会中—会后业务闭环", 16, h - 24, w - 32, 13, NAVY)
        stages = [
            ("会前准备", "会议配置\n背景、JD、公司、简历、资料范围", LIGHT_BLUE, BLUE),
            ("实时会议提醒", "双音源转写、候选问题\n中央建议、引用、待确认", LIGHT_MINT, MINT),
            ("云端复盘前端", "待后端接入\n信息架构、导出/删除", LIGHT_ORANGE, HexColor("#D97706")),
        ]
        box_w, box_h, gap, x = 138, 100, 28, 21
        y = 96
        for i, (title, detail, fill, accent) in enumerate(stages):
            self.draw_box(c, x + i * (box_w + gap), y, box_w, box_h, title, detail, fill, accent=accent)
            if i < 2:
                arrow(c, x + i * (box_w + gap) + box_w, y + box_h / 2, x + (i + 1) * (box_w + gap) - 4, y + box_h / 2, accent)
        arrow(c, 421, 93, 421, 61, INDIGO)
        arrow(c, 421, 61, 91, 61, INDIGO)
        canvas_text(c, "P1 接入真实复盘后，结果可回写为下一次会议配置与资料补齐清单", 95, 48, 326, 8.2, INDIGO, align="center")
        canvas_text(c, "统一底座：本地授权与加密 · 资料范围与引用 · 场景 Skill · 可观测性 · 用户手动控制", 18, 22, w - 36, 8, MUTED, align="center")

    def _technical(self, c, w, h):
        canvas_text(c, "本地优先技术架构：采集、编排、加密存储在本机；推理能力走用户自带云 API", 16, h - 23, w - 32, 12.2, NAVY)
        c.setFillColor(HexColor("#F0F7FF")); c.setStrokeColor(HexColor("#BFD7FF")); c.roundRect(13, 20, 330, h - 53, 9, fill=1, stroke=1)
        c.setFillColor(HexColor("#F6F2FF")); c.setStrokeColor(HexColor("#D6C9FF")); c.roundRect(358, 20, w - 371, h - 53, 9, fill=1, stroke=1)
        canvas_text(c, "本地 macOS 客户端", 26, h - 49, 180, 10.5, BLUE)
        canvas_text(c, "云端用户自带 API", 372, h - 49, 120, 10.5, INDIGO)
        boxes = [
            (27, h - 111, 138, 50, "React / Tauri UI", "会议配置、实时提醒、复盘前端、控制"),
            (183, h - 111, 140, 50, "Swift 原生桥", "ScreenCaptureKit + AVAudioEngine"),
            (27, h - 187, 138, 54, "Rust Core", "状态、命令、加密、会话"),
            (183, h - 187, 140, 54, "MeetingOrchestrator", "受控状态机 + Skill Registry"),
            (27, h - 263, 138, 53, "Repository", "SQLCipher、FTS、本地向量"),
            (183, h - 263, 140, 53, "Keychain / Trace", "密钥隔离、无正文观测\nProvider Facade：唯一云端边界"),
        ]
        for x, y, bw, bh, title, detail in boxes:
            self.draw_box(c, x, y, bw, bh, title, detail, colors.white, accent=CYAN)
        self.draw_box(c, 377, h - 130, 124, 61, "腾讯云实时 ASR", "WebSocket\n最小必要音频帧", LIGHT_MINT, accent=MINT)
        self.draw_box(c, 377, h - 219, 124, 85, "阿里云百炼", "OCR / Embedding\nRerank / 流式 Chat\n最小必要文本或页面", HexColor("#F1EDFF"), accent=INDIGO)
        arrow(c, 165, h - 86, 183, h - 86, CYAN)
        arrow(c, 253, h - 111, 253, h - 132, CYAN)
        arrow(c, 165, h - 160, 183, h - 160, CYAN)
        arrow(c, 96, h - 187, 96, h - 209, CYAN)
        arrow(c, 253, h - 187, 253, h - 209, CYAN)
        arrow(c, 323, h - 160, 375, h - 99, INDIGO)
        arrow(c, 323, h - 160, 375, h - 176, INDIGO)

    def _workflow(self, c, w, h):
        canvas_text(c, "实时 MeetingOrchestrator：固定工具预算，不采用自主 Agent 循环", 16, h - 23, w - 32, 12.2, NAVY)
        nodes = [
            (18, h - 78, 78, 34, "开始 / 授权", LIGHT_BLUE, BLUE),
            (110, h - 78, 78, 34, "音频健康", LIGHT_BLUE, BLUE),
            (202, h - 78, 78, 34, "ASR 最终轮次", LIGHT_MINT, MINT),
            (294, h - 78, 78, 34, "问题候选", LIGHT_MINT, MINT),
            (386, h - 78, 78, 34, "预检索", LIGHT_MINT, MINT),
        ]
        for x, y, bw, bh, title, fill, accent in nodes:
            self.draw_box(c, x, y, bw, bh, title, "", fill, accent=accent)
        for i in range(4):
            arrow(c, 96 + i * 92, h - 61, 106 + i * 92, h - 61, BLUE)
        self.draw_box(c, 292, h - 142, 96, 36, "用户确认？", "默认候选预检索", LIGHT_ORANGE, accent=HexColor("#D97706"))
        arrow(c, 425, h - 78, 340, h - 106, HexColor("#D97706"))
        self.draw_box(c, 76, h - 207, 110, 38, "范围检索", "向量 + FTS + 重排", LIGHT_BLUE, accent=BLUE)
        self.draw_box(c, 201, h - 207, 110, 38, "证据门控", "引用足够？", LIGHT_ORANGE, accent=HexColor("#D97706"))
        self.draw_box(c, 326, h - 207, 110, 38, "流式生成", "建议 + 引用", LIGHT_MINT, accent=MINT)
        arrow(c, 340, h - 142, 131, h - 169, BLUE)
        arrow(c, 186, h - 188, 197, h - 188, BLUE)
        arrow(c, 311, h - 188, 322, h - 188, BLUE)
        self.draw_box(c, 24, h - 255, 150, 42, "降级：手动问题 / FTS-only", "权限、无帧、ASR/向量失败", LIGHT_RED, accent=HexColor("#E11D48"))
        self.draw_box(c, 226, h - 255, 190, 42, "中央答案 + 加密归档", "依据 / 待确认 / Trace", LIGHT_MINT, accent=MINT)
        arrow(c, 256, h - 207, 306, h - 213, MINT)
        arrow(c, 381, h - 207, 333, h - 213, MINT)
        canvas_text(c, "每题最多：1 次 Embedding + 1 次 Rerank + 1 次流式 Chat；模型不选择外部工具。", 21, 8, w - 42, 8, MUTED, align="center")

    def _prototype(self, c, w, h):
        canvas_text(c, "低保真原型：会前 Meeting Packet 与会中中央答案区", 16, h - 23, w - 32, 12.2, NAVY)
        # Left: meeting packet
        x1, y1, ww, hh = 16, 22, 222, h - 55
        c.setFillColor(colors.white); c.setStrokeColor(LINE); c.roundRect(x1, y1, ww, hh, 8, fill=1, stroke=1)
        c.setFillColor(NAVY); c.roundRect(x1, y1 + hh - 27, ww, 27, 8, fill=1, stroke=0)
        canvas_text(c, "新建会议", x1 + 10, y1 + hh - 18, ww - 20, 9, colors.white)
        for idx, text in enumerate(["会议模板：面试会议 / 售前商务会议", "场景、主题、背景（主输入）", "岗位 JD（面试必填）", "公司 / 客户名称", "备注", "个人简历：查看来源 / 编辑确认", "资料范围：已选 简历、方案", "输出：中文 / 60 秒 / 风格格式"]):
            yy = y1 + hh - 48 - idx * 22
            c.setFillColor(BG); c.roundRect(x1 + 10, yy - 11, ww - 20, 17, 3, fill=1, stroke=0)
            canvas_text(c, text, x1 + 16, yy, ww - 32, 6.8, INK)
        c.setFillColor(BLUE); c.roundRect(x1 + ww - 91, y1 + 11, 78, 18, 4, fill=1, stroke=0)
        canvas_text(c, "保存并会前检查", x1 + ww - 84, y1 + 18, 65, 6.5, colors.white, align="center")
        # Right: calm, central-answer card; the production layout can add context panes.
        x2, y2, ww2, hh2 = 253, 22, w - 269, h - 55
        c.setFillColor(colors.white); c.setStrokeColor(LINE); c.roundRect(x2, y2, ww2, hh2, 8, fill=1, stroke=1)
        c.setFillColor(NAVY); c.roundRect(x2, y2 + hh2 - 27, ww2, 27, 8, fill=1, stroke=0)
        canvas_text(c, "售前商务会议 / ● 正在转写 / 00:18:42", x2 + 10, y2 + hh2 - 18, ww2 - 20, 8.6, colors.white)
        canvas_text(c, "实时语境：远端问题已确认 · 本人麦克风有帧 · 系统音频有帧", x2 + 12, y2 + hh2 - 48, ww2 - 24, 7.1, MUTED)
        canvas_text(c, "AI 回答建议", x2 + 12, y2 + hh2 - 72, ww2 - 24, 9.5, BLUE)
        canvas_text(c, "对方问题：平台核心架构和高可用机制是什么？", x2 + 12, y2 + hh2 - 91, ww2 - 24, 7.2, INK)
        c.setFillColor(LIGHT_MINT); c.roundRect(x2 + 12, y2 + hh2 - 154, ww2 - 24, 48, 5, fill=1, stroke=0)
        canvas_text(c, "建议先说（15 秒）：建议采用分层架构，并按实际部署规模设计高可用与容灾。", x2 + 21, y2 + hh2 - 123, ww2 - 42, 7.2, INK, 10)
        canvas_text(c, "回答骨架：1. 总体架构  2. 高可用策略  3. 资料依据  4. 待确认参数", x2 + 12, y2 + hh2 - 174, ww2 - 24, 6.8, MUTED)
        canvas_text(c, "15 秒    60 秒    精简    重答    复制", x2 + 12, y2 + hh2 - 198, ww2 - 24, 7.2, BLUE)
        canvas_text(c, "资料依据：3 条\n待确认：未检索到客户现网部署规模\n控制：切换 Packet / 手动提问 / 暂停 / 结束", x2 + 12, y2 + hh2 - 225, ww2 - 24, 6.8, MUTED, 10)

    def _review(self, c, w, h):
        canvas_text(c, "低保真原型：云端复盘前端（P0 待后端接入）", 16, h - 23, w - 32, 12.2, NAVY)
        x, y, ww, hh = 16, 22, w - 32, h - 55
        c.setFillColor(colors.white); c.setStrokeColor(LINE); c.roundRect(x, y, ww, hh, 8, fill=1, stroke=1)
        c.setFillColor(NAVY); c.roundRect(x, y + hh - 27, ww, 27, 8, fill=1, stroke=0)
        canvas_text(c, "售前商务会议 / 云端复盘服务待接入", x + 11, y + hh - 18, ww - 22, 9, colors.white)
        tabs = ["会议摘要", "问题账本", "回答与证据", "对方关注点", "行动项与练习"]
        tx = x + 12
        for index, tab in enumerate(tabs):
            c.setFillColor(LIGHT_BLUE if index == 0 else BG)
            c.roundRect(tx, y + hh - 52, 80, 16, 4, fill=1, stroke=0)
            canvas_text(c, tab, tx + 5, y + hh - 42, 70, 6.3, BLUE if index == 0 else MUTED, align="center")
            tx += 85
        c.setStrokeColor(LINE); c.line(x + 300, y + 18, x + 300, y + hh - 62)
        c.setFillColor(LIGHT_ORANGE); c.roundRect(x + 18, y + hh - 147, 258, 70, 6, fill=1, stroke=0)
        canvas_text(c, "云端复盘尚未接入", x + 31, y + hh - 101, 225, 11, HexColor("#B45309"))
        canvas_text(c, "当前版本仅验证信息架构与操作路径。不会上传转写、引用或资料，也不会生成任何复盘结论、评分或行动项。", x + 31, y + hh - 121, 225, 7.4, INK, 10)
        self.draw_box(c, x + 321, y + hh - 142, 145, 64, "后续报告结构", "摘要 / 问题账本\n证据 / 待确认 / 行动项", LIGHT_MINT, accent=MINT)
        canvas_text(c, "可用操作", x + 18, y + 107, 260, 9.5, BLUE)
        rows = [
            ("导出当前本地记录", "仅 Markdown", "可用", "不生成报告"),
            ("删除当前会议记录", "本地删除", "可用", "需二次确认"),
            ("生成云端复盘", "服务待接入", "不可用", "P1 另行授权"),
        ]
        for i, row in enumerate(rows):
            yy = y + 78 - i * 26
            c.setFillColor(BG); c.roundRect(x + 18, yy, ww - 36, 22, 3, fill=1, stroke=0)
            canvas_text(c, row[0], x + 24, yy + 13, 150, 6.5, INK)
            canvas_text(c, row[1], x + 178, yy + 13, 62, 6.5, MUTED)
            canvas_text(c, row[2], x + 250, yy + 13, 102, 6.5, MUTED)
            canvas_text(c, row[3], x + 360, yy + 13, 90, 6.5, BLUE)


def section_title(title, kicker=None):
    items = []
    if kicker:
        items.append(p(kicker, ParagraphStyle("kicker", parent=styles["SmallCN"], textColor=BLUE, fontSize=8.5, leading=11)))
    items.append(p(title, styles["H1CN"]))
    return items


def make_table(headers, rows, widths, font_size=7.5):
    header_style = ParagraphStyle("th", parent=styles["SmallCN"], textColor=NAVY, fontSize=font_size, leading=10)
    cell_style = ParagraphStyle("td", parent=styles["SmallCN"], textColor=INK, fontSize=font_size, leading=10)
    data = [[p(h, header_style) for h in headers]] + [[p(cell, cell_style) for cell in row] for row in rows]
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#EAF2FB")),
        ("TEXTCOLOR", (0, 0), (-1, 0), NAVY),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BG]),
    ]))
    return table


def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - 13 * mm, PAGE_W - MARGIN, PAGE_H - 13 * mm)
    canvas.setFont(FONT_NAME, 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, PAGE_H - 9 * mm, "Meeting Copilot V1 产品需求文档（V1.0）")
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 9 * mm, "2026-08-06")
    canvas.line(MARGIN, 11 * mm, PAGE_W - MARGIN, 11 * mm)
    canvas.drawString(MARGIN, 7 * mm, "本文件为 V1.0 产品基线；不构成性能、合规或上线承诺。")
    canvas.drawRightString(PAGE_W - MARGIN, 7 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def build_pdf():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUT), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=20 * mm, bottomMargin=17 * mm, title="Meeting Copilot V1.0 PRD",
        author="Meeting Copilot Product Team",
    )
    story = []
    # Cover
    story += [Spacer(1, 24 * mm), label("V1.0 · P0 功能基线已确认", INDIGO), Spacer(1, 8 * mm)]
    story += [p("Meeting Copilot V1", styles["TitleCN"]), p("线上会议 / 面试助手产品需求文档", styles["TitleCN"])]
    story += [Spacer(1, 6 * mm), p("本地优先 · 场景化上下文 · 可引用实时提醒 · 云端复盘前端", ParagraphStyle("subtitle", parent=styles["BodyCN"], fontSize=12, leading=19, textColor=MUTED))]
    story += [Spacer(1, 18 * mm)]
    cover_table = Table([
        [p("产品定位", styles["CardTitle"]), p("面向个人用户的本地优先会议沟通副驾；只辅助用户决策和表达，不自动代替用户行动。", styles["CardText"])],
        [p("首期重点", styles["CardTitle"]), p("面试会议 + 售前商务会议；技术、普通和自定义会议通过后续模板扩展。", styles["CardText"])],
        [p("首期闭环", styles["CardTitle"]), p("会议配置 → 实时会议提醒 → 云端复盘前端（待接入）→ 下次资料与表达改进。", styles["CardText"])],
        [p("关键状态", styles["CardTitle"]), p("云端复盘初期只有前端，不上传数据或生成报告；3 秒首字、合规状态仍需真实压测或验证。", styles["CardText"])],
    ], colWidths=[36 * mm, CONTENT_W - 36 * mm])
    cover_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_BLUE),
    ]))
    story += [cover_table, Spacer(1, 12 * mm)]
    story += [p("版本 1.0 · 2026-08-06 · 产出方式：产品、技术/智能体、UX 三路审阅后汇总", styles["SmallCN"])]
    story.append(PageBreak())

    # Executive summary
    story += section_title("一页结论", "01 / EXECUTIVE SUMMARY")
    story += [p("Meeting Copilot 的差异化不应是“替用户说话”，而应是让用户在获得授权、掌握资料边界的前提下，更快形成有依据、能说明不确定性的表达。", styles["BodyCN"])]
    executive = make_table(
        ["方向", "结论", "落地原则"],
        [
            ("产品定位", "本地优先会议沟通副驾", "会前组织上下文；会中辅助表达；会后沉淀真实可解释记录"),
            ("优先用户", "求职者、售前/解决方案经理", "优先资料依赖强、价值可衡量的高频场景"),
            ("首期闭环", "会议配置 → 实时提醒 → 复盘前端", "真实云端复盘后端后置 P1；技术/普通/自定义会议采用后续模板"),
            ("可信边界", "引用或待确认", "公司名称不是事实来源；无命中时给澄清建议，不编造"),
            ("智能体策略", "Rust 受控状态机", "实时每题固定调用预算；不使用自主工具循环"),
        ], [29 * mm, 48 * mm, CONTENT_W - 77 * mm], 8.2)
    story += [executive, Spacer(1, 7 * mm)]
    story += [p("必须优先解决的五个问题", styles["H2CN"])]
    story += [bullet("补齐会议配置、简历画像、会话、转写和建议等核心实体；当前会议记录字段不足。"),
              bullet("将“连接成功”改为可验证的音频帧、采样率、ASR 字符和错误状态。"),
              bullet("将资料范围、引用、待确认和用户控制内建进生成链路。"),
              bullet("把实时路径限制为固定、可观测的编排；云端复盘后端在 P1 以单独授权与证据门控实现。"),
              bullet("复盘前端不得伪造报告或评分，且永不输出人格/情绪等无依据推断。")]
    story.append(PageBreak())

    # Scope and business architecture
    story += section_title("产品范围与业务架构", "02 / PRODUCT SCOPE")
    story += [Diagram("business", height=250), Spacer(1, 6 * mm)]
    scope_table = make_table(
        ["模块", "P0：首期", "P1：增强", "P2：探索"],
        [
            ("会前上下文", "会议配置、场景背景、JD、公司、备注、简历、资料范围、会议要求", "角色/目标/禁答边界、模板复用", "团队模板"),
            ("实时提醒", "双音源健康、转写、候选问题、手动触发、中央回答、引用/待确认", "快捷键、追问、双语、术语表", "多人聚类"),
            ("云端复盘", "前端页、待接入态、Markdown 导出/删除入口", "授权、后端任务、真实报告与导出", "个人成长画像"),
            ("知识库与观测", "范围选择、引用定位、模型耗时/错误/用量", "标签、敏感等级、单会话 Trace", "团队治理"),
        ], [25 * mm, 66 * mm, 45 * mm, CONTENT_W - 136 * mm], 7.2)
    story += [scope_table]
    story.append(PageBreak())

    # Requirements / acceptance
    story += section_title("P0 功能需求与验收标准", "03 / MUST-HAVE REQUIREMENTS")
    requirements = make_table(
        ["需求", "交付内容", "可验收标准"],
        [
            ("FR-01 会议配置", "自然语言背景、JD、公司、备注、简历、资料范围、输出要求、Skill 版本", "可保存/复制/编辑；简历人工确认后才生效；检索不越出授权资料范围"),
            ("FR-02 实时会议提醒", "权限/音频帧/ASR/问题候选/检索/生成状态；中央建议与引用", "麦克风/系统音频帧和 ASR 字符可见；无证据输出待确认；支持暂停、手动提问、复制、重试"),
            ("FR-03 云端复盘前端", "页签、待接入/空态、Markdown 导出和删除入口", "无复盘 API、无上传、无伪造报告/评分；服务待接入状态明确"),
            ("FR-04 观测与数据控制", "Trace、错误、耗时、估算用量、留存/导出/删除入口", "日志不含密钥、完整提示词、完整转写、原始音频和资料正文"),
        ], [33 * mm, 62 * mm, CONTENT_W - 95 * mm], 7.6)
    story += [requirements, Spacer(1, 6 * mm)]
    story += [p("实时状态与用户可见反馈", styles["H2CN"])]
    story += [p("权限检查 → 音频帧已接收 → ASR 连接中 → 正在转写 → 发现疑似问题 → 正在检索 → 正在组织建议 → 已完成 / 降级。任何状态不得用“连接成功”替代有效转写。", styles["BodyCN"])]
    story += [p("首字时延的工程目标为“问题结束至首个可读建议 P95 ≤ 3 秒”。在目标设备、网络和模型的 50 条测试集压测通过前，它不是已实现性能或对外承诺。", ParagraphStyle("warning", parent=styles["BodyCN"], textColor=HexColor("#B45309"), backColor=LIGHT_ORANGE, borderPadding=7))]
    story.append(PageBreak())

    # Tech architecture
    story += section_title("技术架构与本地/云端边界", "04 / TECHNICAL ARCHITECTURE")
    story += [Diagram("technical", height=286), Spacer(1, 5 * mm)]
    tech_boundary = make_table(
        ["位置", "职责", "明确边界"],
        [
            ("前端 UI", "输入、展示、控制、引用展开", "不接触 API Key，不直连云模型"),
            ("Swift 原生桥", "系统音频、麦克风、权限、设备状态", "不做模型推理，默认不落盘原始音频"),
            ("Rust Core", "编排、加密存储、Provider 调用、状态和审计", "不执行任意外部动作"),
            ("Provider Facade", "唯一读取 Keychain 并调用云端 API 的边界", "不把密钥返给 UI，不自动跨供应商切换"),
            ("云模型", "ASR/OCR/向量/重排/生成", "仅接收完成任务的最小必要音频帧、页面或文本片段"),
        ], [28 * mm, 66 * mm, CONTENT_W - 94 * mm], 7.5)
    story += [tech_boundary]
    story.append(PageBreak())

    # Agent workflow
    story += section_title("智能体工作流程与 Skills", "05 / AGENT ORCHESTRATION")
    story += [Diagram("workflow", height=275), Spacer(1, 5 * mm)]
    story += [p("选型结论：V1 使用 Rust `MeetingOrchestrator`，不在实时主链引入 LangChain/LangGraph/CrewAI/AutoGen。LangGraph 可在未来账户、长任务恢复、多人协作场景中评估用于异步复盘；ReAct 只作为会后最多两轮的受控补充检索模式。", styles["BodyCN"])]
    skill_table = make_table(
        ["内置 Skill", "触发场景", "输出契约"],
        [
            ("interview.star.v1", "通用面试", "结论、S/T/A/R、待确认"),
            ("interview.tech.v1", "技术面 / 系统设计", "澄清、方案、取舍、风险、验证"),
            ("presales.solution.v1", "售前 / 商机", "价值、方案、边界、待确认、下一步"),
            ("meeting.action.v1", "技术/普通会议", "结论、决策、待办、责任、风险"),
            ("review.*.v1", "面试/商务复盘", "问题账本、证据覆盖、行动/练习"),
        ], [45 * mm, 53 * mm, CONTENT_W - 98 * mm], 7.5)
    story += [skill_table]
    story.append(PageBreak())

    # Models/security/observability
    story += section_title("数据模型、可信度与可观测性", "06 / DATA AND TRUST")
    data_table = make_table(
        ["实体", "关键字段", "目的"],
        [
            ("MeetingPacket", "场景背景、JD、公司、备注、输出要求、Skill、范围、简历画像", "冻结会前会议上下文，减少会中歧义"),
            ("ResumeProfile", "来源、经历、技能、项目、引用、确认时间", "简历解析结果必须人工确认；不新增默认脱敏要求"),
            ("MeetingSession / TranscriptTurn", "授权、起止、留存策略、音源、文本、时间", "真实会话本地加密档案"),
            ("QuestionCandidate / Suggestion", "触发方式、意图、回答、引用、首字耗时、状态", "提醒决策与回答可追溯"),
            ("ReviewReport（P1）/ TraceSpan", "摘要、账本、风险、行动；trace/session/turn/span", "P1 复盘解释性与端到端可观测性"),
        ], [44 * mm, 73 * mm, CONTENT_W - 117 * mm], 7.4)
    story += [data_table, Spacer(1, 6 * mm)]
    story += [p("可信度门控", styles["H2CN"])]
    story += [bullet("公司或客户名称仅作上下文标签；无来源时不能作为业务、技术栈或现状事实输出。"),
              bullet("所有资料型表达必须含引用或“待确认”状态；无命中时只输出澄清问题或边界。"),
              bullet("材料、JD、简历和转写都被视为不可信内容，不能改变工具权限、资料范围或外部行动策略。"),
              bullet("原始音频默认不保存；API Key 与本地根密钥仅在 Keychain / Rust Core 边界使用。")]
    story += [p("Trace 结构：traceId → sessionId → turnId → spanId。记录帧数、首帧、ASR 首字/最终字、检索、重排、首字、完成、错误和估算用量；不记录密钥、完整提示词、完整转写、原始音频或资料正文。", ParagraphStyle("trace", parent=styles["BodyCN"], backColor=LIGHT_BLUE, borderPadding=7))]
    story.append(PageBreak())

    # UX wireframe
    story += section_title("前端原型：会前与会中", "07 / UX WIREFRAMES")
    story += [Diagram("prototype", height=330), Spacer(1, 4 * mm)]
    story += [p("核心 UX 决策：会中屏幕中央始终是“AI 回答建议”，而不是转写。左侧只放实时语境与音频健康，右侧只放本次 Packet、风格与手动控制；用户在压力场景下能先看到可说的第一句话，再按需要展开依据。", styles["BodyCN"])]
    story.append(PageBreak())

    # Review wireframe
    story += section_title("前端原型：云端复盘前端", "08 / UX WIREFRAME")
    story += [Diagram("review", height=315), Spacer(1, 5 * mm)]
    story += [p("本页面在 P0 只验证信息架构和状态：不上传转写、不调用模型、不生成报告。P1 接入后，“对方关注点”也只能从本次问题主题归纳技术、价值、风险、价格或协作关注方向，并明确标注为基于会话的推断；不使用人格、情绪、诚信或抗压等不可解释评价。", styles["BodyCN"])]
    story.append(PageBreak())

    # Development plan
    story += section_title("开发路线图与质量门禁", "09 / DELIVERY PLAN")
    plan_table = make_table(
        ["阶段", "用户价值", "主要交付", "进入下一阶段的门禁"],
        [
            ("0.2 会议配置", "会前上下文和资料范围可复用、可审计", "Packet、简历人工确认、范围隔离、Skill Registry、数据迁移", "确认前简历不能入上下文；资料不越界"),
            ("0.3 实时会议提醒", "实时得到可说、可证、可确认的建议", "双音源健康、Session/Turn、候选问题、受控编排、中央答案", "真实帧数/ASR 文字可查；50 条测试集首字 P95 ≤ 3 秒"),
            ("0.4 复盘前端", "验证复盘信息架构与用户预期", "页签、待接入/空态、Markdown 导出和删除入口", "无云端请求、无上传、无伪造报告或评分"),
            ("P1 复盘后端/扩展", "将复盘转成真实行动与练习资料", "授权、报告任务图、证据、行动项、训练、悬浮窗", "单独通过数据流、成本、证据与合规审查"),
        ], [29 * mm, 43 * mm, 63 * mm, CONTENT_W - 135 * mm], 7.3)
    story += [plan_table, Spacer(1, 7 * mm)]
    story += [p("必须通过的测试矩阵", styles["H2CN"])]
    story += [p("权限与音频：缺权限、单音源、无帧、设备切换；ASR：鉴权、长时间无数据、中英、部分结果；RAG：范围隔离、无命中、Embedding/Rerank 故障；生成：流式超时、重试、待确认；复盘：长会话、编辑重跑、导出/删除；安全：Keychain 遮罩、日志泄漏、提示注入。", styles["BodyCN"])]
    story.append(PageBreak())

    # Confirmed scope page
    story += section_title("已确认的 P0 功能基线", "10 / CONFIRMED SCOPE")
    story += [p("以下基线已由产品负责人确认。高级会议字段未被单独选择，按此前推荐默认值后置 P1。云端复盘前端已纳入 P0，但不等于云端复盘后端已经实现。", styles["BodyCN"])]
    confirm_table = make_table(
        ["#", "已确认项", "V1.0 基线", "主要影响"],
        [
            ("1", "首期会议模板", "面试会议 + 售前商务会议；UI 统一称为“会议”", "Skill 路由、测试集、导航术语"),
            ("2", "高级会议字段", "角色/目标/禁答边界 P1（采用推荐默认值）", "P0 表单与数据模型最小化"),
            ("3", "简历处理", "不强制加密/脱敏；人工确认后使用", "来源、确认、删除与资料范围"),
            ("4", "云端复盘", "P0 仅前端界面；不接后端、不上传数据", "状态设计、Trace、产品预期"),
            ("5", "导出范围", "P0 仅 Markdown", "导出与集成工作量"),
            ("6", "提醒触发", "候选预检索 + 用户确认", "误触、时延、信任"),
            ("7", "会中展示", "主客户端中央答案；悬浮窗 P1", "UX、窗口管理"),
            ("8", "安全边界", "不自动发言/发送；不分析他人人格或情绪", "合规、产品文案"),
        ], [10 * mm, 38 * mm, 82 * mm, CONTENT_W - 130 * mm], 7.25)
    story += [confirm_table, Spacer(1, 10 * mm)]
    story += [p("实施顺序", styles["H2CN"]), p("下一步按 0.2 会议配置 → 0.3 实时会议提醒 → 0.4 云端复盘前端拆分开发任务。P1 云端复盘后端需要另行确认授权、数据范围、成本、证据与合规。", styles["BodyCN"])]
    story += [Spacer(1, 8 * mm), p("参考资料：现有项目代码与文档；OfferGoose 公开介绍；LangGraph 与 LangChain 官方文档。所有供应商能力、时延、成本和合规均以实际配置与验收为准。", styles["SmallCN"])]

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(OUT)


if __name__ == "__main__":
    build_pdf()
