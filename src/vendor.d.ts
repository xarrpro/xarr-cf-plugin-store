// 通过 wrangler 的 Text 模块规则把 .txt 产物作为字符串导入(离线自托管的 Shoelace/fflate)
declare module "*.txt" {
  const content: string;
  export default content;
}
