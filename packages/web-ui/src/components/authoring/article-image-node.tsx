"use client";

import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactElement } from "react";

export type SerializedArticleImageNode = Spread<{
  src: string;
  alt: string;
  caption?: string;
}, SerializedLexicalNode>;

export class ArticleImageNode extends DecoratorNode<ReactElement> {
  __src: string;
  __alt: string;
  __caption: string;

  static getType(): string { return "image"; }

  static clone(node: ArticleImageNode): ArticleImageNode {
    return new ArticleImageNode(node.__src, node.__alt, node.__caption, node.__key);
  }

  constructor(src: string, alt: string, caption = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
    this.__caption = caption;
  }

  static importJSON(serialized: SerializedArticleImageNode): ArticleImageNode {
    return $createArticleImageNode({
      src: serialized.src,
      alt: serialized.alt,
      caption: serialized.caption ?? "",
    });
  }

  exportJSON(): SerializedArticleImageNode {
    return {
      ...super.exportJSON(),
      type: "image",
      version: 1,
      src: this.__src,
      alt: this.__alt,
      ...(this.__caption ? { caption: this.__caption } : {}),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "nw-lexical-image-host";
    return wrapper;
  }

  updateDOM(): false { return false; }

  decorate(): ReactElement {
    return (
      <figure className="nw-lexical-image">
        {/* The API stores normalized WebP images behind the same-origin public media route. */}
        <img src={this.__src} alt={this.__alt} loading="lazy" />
        {this.__caption ? <figcaption>{this.__caption}</figcaption> : null}
      </figure>
    );
  }
}

export function $createArticleImageNode({ src, alt, caption = "" }: { src: string; alt: string; caption?: string }): ArticleImageNode {
  return $applyNodeReplacement(new ArticleImageNode(src, alt, caption));
}

export function $isArticleImageNode(node: LexicalNode | null | undefined): node is ArticleImageNode {
  return node instanceof ArticleImageNode;
}
