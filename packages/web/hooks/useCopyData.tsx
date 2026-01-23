import { useTranslation } from 'next-i18next';
import { useToast } from './useToast';
import { useCallback } from 'react';
import MyModal from '../components/common/MyModal';
import React from 'react';
import { Box, ModalBody } from '@chakra-ui/react';
import Tag from '../components/common/Tag';
import { useCommonStore } from '../store/useCommonStore';

/**
 * copy text data
 */
export const useCopyData = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { setCopyContent } = useCommonStore();

  const copyData = useCallback(
    async (
      data: string,
      title: string | null | undefined = t('common:copy_successful'),
      duration = 1000
    ) => {
      data = data.trim();

      // 尝试多种复制方法
      const copyMethods = [
        // 方法1: 现代 Clipboard API
        async () => {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(data);
            return true;
          }
          return false;
        },
        // 方法2: 传统的 execCommand 方法
        async () => {
          const textarea = document.createElement('textarea');
          textarea.value = data;
          textarea.style.position = 'fixed';
          textarea.style.left = '-999999px';
          textarea.style.top = '-999999px';
          textarea.style.opacity = '0';
          textarea.style.pointerEvents = 'none';
          textarea.setAttribute('readonly', '');
          document.body.appendChild(textarea);

          // 对于移动设备，需要特殊处理
          if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
            textarea.contentEditable = 'true';
            textarea.readOnly = false;
            const range = document.createRange();
            range.selectNodeContents(textarea);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            textarea.setSelectionRange(0, 999999);
          } else {
            textarea.focus();
            textarea.select();
          }

          try {
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            return successful;
          } catch (err) {
            document.body.removeChild(textarea);
            return false;
          }
        },
        // 方法3: 创建可见的文本框让用户手动选择
        async () => {
          // 这个方法实际上不会自动复制，而是为手动复制做准备
          return false;
        }
      ];

      // 依次尝试每种复制方法
      for (const method of copyMethods) {
        try {
          const success = await method();
          if (success) {
            if (title) {
              toast({
                title,
                status: 'success',
                duration
              });
            }
            return;
          }
        } catch (error) {
          // 继续尝试下一种方法
          continue;
        }
      }

      // 所有方法都失败，显示手动复制弹窗
      setCopyContent(data);
    },
    [setCopyContent, t, toast]
  );

  return {
    copyData
  };
};

export const ManualCopyModal = () => {
  const { t } = useTranslation();
  const { copyContent, setCopyContent } = useCommonStore();

  const handleSelectAll = () => {
    const textBox = document.getElementById('manual-copy-text');
    if (textBox) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(textBox);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  return (
    <MyModal
      isOpen={!!copyContent}
      iconSrc="copy"
      iconColor="primary.600"
      title={t('common:Copy')}
      maxW={['90vw', '500px']}
      w={'100%'}
      onClose={() => setCopyContent(undefined)}
    >
      <ModalBody>
        <Tag w={'100%'} colorSchema="blue" mb={3}>
          {t('common:can_copy_content_tip')}
        </Tag>
        <Box
          id="manual-copy-text"
          borderRadius={'md'}
          p={3}
          border={'base'}
          userSelect={'all'}
          maxH={'300px'}
          overflowY={'auto'}
          bg={'gray.50'}
          cursor={'text'}
          onClick={handleSelectAll}
          _hover={{ bg: 'gray.100' }}
        >
          {copyContent}
        </Box>
        <Box mt={2} fontSize={'sm'} color={'gray.600'} textAlign={'center'}>
          {t('common:click_to_select_all')}
        </Box>
      </ModalBody>
    </MyModal>
  );
};
